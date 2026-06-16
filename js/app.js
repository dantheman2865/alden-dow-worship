import * as store from "./store.js";

const DATA_URL = "alden_dow_religious_buildings.json";

const state = {
  records: [], // {id, raw, lat, lng, hasLocation}
  filter: "all",
  query: "",
  editMode: false,
  activeId: null,
  markers: new Map(), // id -> Leaflet marker
  lightbox: { entries: [], index: 0 }, // photos currently viewable in the lightbox
};

let lightboxReqId = 0; // guards against an earlier slow load overwriting a newer one

let map;
let markerLayer;

// ---- boot --------------------------------------------------------------------

async function boot() {
  await store.init();
  const res = await fetch(DATA_URL, { cache: "no-store" });
  const data = await res.json();

  state.records = data.records.map((raw) => {
    const lat = typeof raw.latitude === "number" ? raw.latitude : null;
    const lng = typeof raw.longitude === "number" ? raw.longitude : null;
    return {
      id: store.recordId(raw),
      raw,
      lat,
      lng,
      hasLocation: lat !== null && lng !== null,
    };
  });

  initMap();
  wireControls();
  await render();
}

// ---- map ---------------------------------------------------------------------

function initMap() {
  map = L.map("map", { scrollWheelZoom: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  const located = state.records.filter((r) => r.hasLocation);
  if (located.length) {
    const bounds = L.latLngBounds(located.map((r) => [r.lat, r.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  } else {
    map.setView([43.6, -84.2], 7); // Midland, MI fallback
  }
}

function pinIcon(visited) {
  return L.divIcon({
    className: "",
    html: `<div class="pin${visited ? " visited" : ""}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
    popupAnchor: [0, -16],
  });
}

// ---- rendering ---------------------------------------------------------------

// effective state for every record, fetched once per render pass
async function effectiveMap() {
  const entries = await Promise.all(
    state.records.map(async (r) => [r.id, await store.getEffective(r.id)])
  );
  return new Map(entries);
}

function matchesFilter(eff) {
  if (state.filter === "visited") return eff.visited;
  if (state.filter === "unvisited") return !eff.visited;
  return true;
}

function matchesQuery(record) {
  if (!state.query) return true;
  const r = record.raw;
  const hay = `${r.structure_name} ${r.matched_name || ""} ${r.location_listed} ${
    r.matched_address || ""
  } ${r.year}`.toLowerCase();
  return hay.includes(state.query);
}

async function render() {
  const eff = await effectiveMap();
  renderProgress(eff);
  renderList(eff);
  renderMarkers(eff);
  await refreshPublishStatus();
}

function renderProgress(eff) {
  const visited = state.records.filter((r) => eff.get(r.id).visited).length;
  document.getElementById("progress").textContent = `${visited} / ${state.records.length} visited`;
}

function renderList(eff) {
  const ul = document.getElementById("list");
  ul.innerHTML = "";

  const visible = state.records
    .filter((r) => matchesQuery(r) && matchesFilter(eff.get(r.id)))
    .sort((a, b) => Number(a.raw.year) - Number(b.raw.year));

  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `<div class="empty-note">No buildings match.</div>`;
    ul.appendChild(li);
    return;
  }

  for (const record of visible) {
    const e = eff.get(record.id);
    const li = document.createElement("li");
    li.className = `list-item${e.visited ? " visited" : ""}${
      record.id === state.activeId ? " is-active" : ""
    }`;
    li.dataset.id = record.id;

    const tags = [];
    if (e.visited) tags.push(`<span class="tag tag-visited">✓ Visited</span>`);
    if (e.photos.length)
      tags.push(`<span class="tag tag-photos">${e.photos.length} photo${e.photos.length > 1 ? "s" : ""}</span>`);
    if (!record.hasLocation) tags.push(`<span class="tag tag-warn">location unverified</span>`);

    li.innerHTML = `
      <span class="item-dot"></span>
      <div class="item-body">
        <div class="item-name">${escapeHtml(record.raw.structure_name)}</div>
        <div class="item-meta">${escapeHtml(record.raw.location_listed)} · ${record.raw.year}</div>
        <div>${tags.join("")}</div>
      </div>`;
    li.addEventListener("click", () => openDrawer(record.id));
    ul.appendChild(li);
  }
}

function renderMarkers(eff) {
  markerLayer.clearLayers();
  state.markers.clear();

  for (const record of state.records) {
    if (!record.hasLocation) continue;
    const e = eff.get(record.id);
    if (!matchesQuery(record) || !matchesFilter(e)) continue;

    const marker = L.marker([record.lat, record.lng], { icon: pinIcon(e.visited) });
    marker.bindTooltip(`${record.raw.structure_name} (${record.raw.year})`);
    marker.on("click", () => openDrawer(record.id));
    marker.addTo(markerLayer);
    state.markers.set(record.id, marker);
  }
}

// ---- drawer ------------------------------------------------------------------

async function openDrawer(id) {
  state.activeId = id;
  const record = state.records.find((r) => r.id === id);
  const eff = await store.getEffective(id);
  const r = record.raw;

  const links = [];
  if (r.abdow_url) links.push(`<a href="${r.abdow_url}" target="_blank" rel="noopener">abdow.org ↗</a>`);
  const gmaps = r.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}`
    : record.hasLocation
    ? `https://www.google.com/maps/search/?api=1&query=${record.lat},${record.lng}`
    : null;
  if (gmaps) links.push(`<a href="${gmaps}" target="_blank" rel="noopener">Google Maps ↗</a>`);

  const html = `
    <h2>${escapeHtml(r.structure_name)}</h2>
    <p class="d-sub">${escapeHtml(r.location_listed)} · ${r.year}${
    r.matched_name && r.matched_name !== r.structure_name
      ? ` · now <em>${escapeHtml(r.matched_name)}</em>`
      : ""
  }</p>

    ${
      r.matched_address
        ? `<div class="d-section"><div class="d-label">Address</div><div>${escapeHtml(
            r.matched_address
          )}</div></div>`
        : ""
    }
    ${!record.hasLocation ? `<div class="tag tag-warn">Location unverified — not shown on map</div>` : ""}

    ${links.length ? `<div class="d-section"><div class="d-links">${links.join("")}</div></div>` : ""}

    ${
      r.notes
        ? `<div class="d-section"><div class="d-label">Research notes</div><div class="d-notes">${escapeHtml(
            r.notes
          )}</div></div>`
        : ""
    }

    <div class="d-section" id="visit-section"></div>
    <div class="d-section">
      <div class="d-label">Photos</div>
      <div class="photo-grid" id="photo-grid"></div>
      <div id="photo-control"></div>
    </div>
  `;

  document.getElementById("drawer-content").innerHTML = html;
  renderVisitSection(id, eff);
  await renderPhotos(id, eff);

  document.getElementById("drawer").hidden = false;
  // refresh list/markers to reflect active highlight
  await render();

  // Zoom the map to the selected location (records without coordinates can't be located).
  if (record.hasLocation) flyToRecord(record);
}

// Fly the map to a record, nudging the center left on wide screens so the marker
// isn't hidden behind the detail panel.
function flyToRecord(record) {
  const targetZoom = Math.max(map.getZoom(), 14);
  const point = map.project([record.lat, record.lng], targetZoom);
  if (window.innerWidth > 820) point.x += 230; // ~half the 460px panel width
  map.flyTo(map.unproject(point, targetZoom), targetZoom, { duration: 1.5 });
  const marker = state.markers.get(record.id);
  if (marker) marker.openTooltip();
}

function renderVisitSection(id, eff) {
  const el = document.getElementById("visit-section");
  if (!el) return;

  if (state.editMode) {
    el.innerHTML = `
      <label class="visited-check">
        <input type="checkbox" id="f-visited" ${eff.visited ? "checked" : ""} />
        <span>Mark as visited</span>
      </label>
      <div class="field" style="margin-top:12px">
        <label for="f-date">Date visited</label>
        <input type="date" id="f-date" value="${eff.date || ""}" />
      </div>
      <div class="field">
        <label for="f-notes">My notes</label>
        <textarea id="f-notes" placeholder="Impressions, who you went with, weather…">${escapeHtml(
          eff.notes || ""
        )}</textarea>
      </div>`;

    el.querySelector("#f-visited").addEventListener("change", async (e) => {
      await store.setField(id, "visited", e.target.checked);
      await render();
    });
    el.querySelector("#f-date").addEventListener("change", async (e) => {
      await store.setField(id, "date", e.target.value);
      if (e.target.value) {
        const cb = el.querySelector("#f-visited");
        if (!cb.checked) {
          cb.checked = true;
          await store.setField(id, "visited", true);
        }
      }
      await render();
    });
    el.querySelector("#f-notes").addEventListener("input", debounce(async (e) => {
      await store.setField(id, "notes", e.target.value);
    }, 400));
  } else {
    const bits = [];
    if (eff.visited) {
      bits.push(
        `<div class="visited-badge">✓ Visited${eff.date ? ` · ${formatDate(eff.date)}` : ""}</div>`
      );
    } else {
      bits.push(`<div class="empty-note">Not visited yet. Turn on Edit mode to log a visit.</div>`);
    }
    if (eff.notes) bits.push(`<div class="d-notes" style="margin-top:10px">${escapeHtml(eff.notes)}</div>`);
    el.innerHTML = bits.join("");
  }
}

async function renderPhotos(id, eff) {
  const grid = document.getElementById("photo-grid");
  const control = document.getElementById("photo-control");
  if (!grid) return;
  grid.innerHTML = "";

  if (!eff.photos.length && !state.editMode) {
    grid.innerHTML = `<div class="empty-note">No photos yet.</div>`;
  }

  for (let i = 0; i < eff.photos.length; i++) {
    const entry = eff.photos[i];
    const thumbSrc = await store.photoSrc(entry, "thumb");
    const cell = document.createElement("div");
    cell.className = "photo-cell";
    cell.innerHTML = `<img src="${thumbSrc}" alt="" loading="lazy" />${
      state.editMode ? `<button class="photo-remove" title="Remove">&times;</button>` : ""
    }`;
    // Open the lightbox on the full gallery, starting at this photo. The full-res
    // image is fetched lazily inside the lightbox.
    cell.querySelector("img").addEventListener("click", () => openLightbox(eff.photos, i));
    if (state.editMode) {
      cell.querySelector(".photo-remove").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await store.removePhoto(id, i);
        const updated = await store.getEffective(id);
        await renderPhotos(id, updated);
        await render();
      });
    }
    grid.appendChild(cell);
  }

  if (state.editMode && control) {
    control.innerHTML = `
      <div class="dropzone" id="dropzone">
        Drag photos here, or <strong>click to choose</strong>
        <input type="file" id="file-input" accept="image/*" multiple hidden />
      </div>`;
    const dz = control.querySelector("#dropzone");
    const input = control.querySelector("#file-input");
    dz.addEventListener("click", () => input.click());
    input.addEventListener("change", () => handleFiles(id, input.files));
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      handleFiles(id, e.dataTransfer.files);
    });
  } else if (control) {
    control.innerHTML = "";
  }
}

async function handleFiles(id, fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  for (const file of files) {
    await store.addPhoto(id, file);
  }
  const eff = await store.getEffective(id);
  await renderPhotos(id, eff);
  await render();
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  document.getElementById("drawer-overlay").hidden = true;
  state.activeId = null;
  render();
}

// ---- lightbox ----------------------------------------------------------------

// Open the lightbox on a gallery (array of photo entries) at a starting index.
function openLightbox(entries, index) {
  state.lightbox = { entries, index };
  document.getElementById("lightbox").hidden = false;
  showLightboxPhoto();
}

function closeLightbox() {
  document.getElementById("lightbox").hidden = true;
}

// Move within the current gallery, wrapping around the ends.
function lightboxStep(delta) {
  const { entries, index } = state.lightbox;
  if (entries.length < 2) return;
  state.lightbox.index = (index + delta + entries.length) % entries.length;
  showLightboxPhoto();
}

// Render the current photo: clear the previous image, show a spinner, then swap in
// the full-resolution image once it has decoded.
async function showLightboxPhoto() {
  const { entries, index } = state.lightbox;
  const entry = entries[index];
  const img = document.getElementById("lightbox-img");
  const spinner = document.getElementById("lightbox-spinner");
  const counter = document.getElementById("lightbox-counter");
  const multi = entries.length > 1;

  document.querySelector(".lightbox-prev").hidden = !multi;
  document.querySelector(".lightbox-next").hidden = !multi;
  counter.textContent = multi ? `${index + 1} / ${entries.length}` : "";

  const reqId = ++lightboxReqId;
  img.style.visibility = "hidden";
  img.removeAttribute("src"); // drop the previous photo immediately — no stale flash
  spinner.hidden = false;

  const src = await store.photoSrc(entry, "full");
  if (reqId !== lightboxReqId) return; // a newer navigation superseded this one
  img.onload = () => {
    if (reqId !== lightboxReqId) return;
    spinner.hidden = true;
    img.style.visibility = "visible";
  };
  img.onerror = () => {
    if (reqId === lightboxReqId) spinner.hidden = true;
  };
  img.src = src;
}

// ---- publish bar -------------------------------------------------------------

async function refreshPublishStatus() {
  const statusEl = document.getElementById("publish-status");
  if (!statusEl) return;
  const dirty = await store.hasLocalEdits();
  statusEl.textContent = dirty
    ? "You have unpublished local edits. Publish, then commit the changed files to your repo."
    : "No local edits. Everything shown is from the committed data.";
  document.getElementById("btn-save-folder").disabled = !store.canSaveToFolder();
}

function wireControls() {
  // search
  document.getElementById("search").addEventListener(
    "input",
    debounce((e) => {
      state.query = e.target.value.trim().toLowerCase();
      render();
    }, 200)
  );

  // filters
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.filter = btn.dataset.filter;
      render();
    });
  });

  // edit mode
  document.getElementById("edit-mode").addEventListener("change", (e) => {
    state.editMode = e.target.checked;
    document.getElementById("publish-bar").hidden = !state.editMode;
    if (state.activeId) openDrawer(state.activeId);
    else render();
  });

  // drawer close
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);

  // lightbox: close on backdrop/stage click, navigate with the arrow buttons
  const lb = document.getElementById("lightbox");
  lb.addEventListener("click", (e) => {
    if (e.target === lb || e.target.classList.contains("lightbox-stage")) closeLightbox();
  });
  document.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
  document.querySelector(".lightbox-prev").addEventListener("click", (e) => {
    e.stopPropagation();
    lightboxStep(-1);
  });
  document.querySelector(".lightbox-next").addEventListener("click", (e) => {
    e.stopPropagation();
    lightboxStep(1);
  });

  // keyboard: Escape closes; arrows navigate when the lightbox is open
  document.addEventListener("keydown", (e) => {
    const lbOpen = !lb.hidden;
    if (e.key === "Escape") {
      if (lbOpen) closeLightbox();
      else if (!document.getElementById("drawer").hidden) closeDrawer();
    } else if (lbOpen && e.key === "ArrowLeft") {
      lightboxStep(-1);
    } else if (lbOpen && e.key === "ArrowRight") {
      lightboxStep(1);
    }
  });

  // publish actions
  document.getElementById("btn-save-folder").addEventListener("click", async () => {
    try {
      const r = await store.publishToFolder();
      toast(`Saved ${r.files} file(s) to the repo folder. Now commit them.`);
      await refreshPublishStatus();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      toast("Save failed: " + (err.message || err));
    }
  });
  document.getElementById("btn-zip").addEventListener("click", async () => {
    const r = await store.publishZip();
    toast(`Built dow-publish.zip (${r.files} file(s)). Unzip into the repo root, then commit.`);
  });
  document.getElementById("btn-export").addEventListener("click", () => store.exportMetadata());
  document.getElementById("btn-clear").addEventListener("click", async () => {
    if (!confirm("Clear all local edits? Do this only after you've published & committed them.")) return;
    await store.clearLocalEdits();
    if (state.activeId) await openDrawer(state.activeId);
    await render();
    toast("Local edits cleared.");
  });
}

// ---- helpers -----------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function toast(msg) {
  const el = document.getElementById("publish-status");
  if (el) el.textContent = msg;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="padding:16px;background:#fdeede;color:#8c4e16">Failed to load: ${escapeHtml(
      err.message || String(err)
    )}</div>`
  );
});
