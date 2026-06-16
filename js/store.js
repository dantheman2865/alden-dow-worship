// Working-copy store: merges the committed read-only layer (data/visits.json + photos/)
// with local browser edits (IndexedDB), and publishes edits back into the repo.

import { createZip } from "./zip.js";

const DB_NAME = "dow-worship";
const DB_VERSION = 1;
const COMMITTED_URL = "data/visits.json";

let db = null;
let committed = { version: 1, visits: {} };
const objectUrlCache = new Map(); // photoKey -> object URL

// ---- deterministic record id -------------------------------------------------

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function recordId(record) {
  return slugify(`${record.year}-${record.structure_name}-${record.location_listed}`);
}

// ---- IndexedDB plumbing ------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("edits")) d.createObjectStore("edits", { keyPath: "id" });
      if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? storeNames.map((n) => transaction.objectStore(n))
      : transaction.objectStore(storeNames);
    let result;
    Promise.resolve(fn(stores))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- init --------------------------------------------------------------------

export async function init() {
  db = await openDb();
  try {
    const res = await fetch(COMMITTED_URL, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      committed = { version: 1, visits: data.visits || {} };
    }
  } catch {
    // No committed file yet — start empty.
  }
}

// ---- edit records ------------------------------------------------------------

function emptyEdit(id) {
  return { id, visited: false, date: "", notes: "", photos: [] };
}

// A committed photo may be a legacy string path or a { full, thumb } object.
function repoPhotoEntry(p) {
  if (typeof p === "string") return { kind: "repo", full: p, thumb: p };
  return { kind: "repo", full: p.full, thumb: p.thumb || p.full };
}

function committedToEntry(visit) {
  return {
    visited: !!visit.visited,
    date: visit.date || "",
    notes: visit.notes || "",
    photos: (visit.photos || []).map(repoPhotoEntry),
  };
}

async function getEdit(id) {
  return tx("edits", "readonly", (store) => reqToPromise(store.get(id)));
}

async function putEdit(edit) {
  return tx("edits", "readwrite", (store) => reqToPromise(store.put(edit)));
}

// Effective state = local edit if present, else committed, else empty.
export async function getEffective(id) {
  const edit = await getEdit(id);
  if (edit) return edit;
  const visit = committed.visits[id];
  if (visit) return { id, ...committedToEntry(visit) };
  return emptyEdit(id);
}

// Returns committed-or-empty without touching IndexedDB. Used to seed an edit.
function committedEffective(id) {
  const visit = committed.visits[id];
  return visit ? { id, ...committedToEntry(visit) } : emptyEdit(id);
}

// Ensure a mutable edit record exists, seeded from committed state on first edit.
async function ensureEdit(id) {
  let edit = await getEdit(id);
  if (!edit) {
    edit = committedEffective(id);
    await putEdit(edit);
  }
  return edit;
}

export async function setField(id, field, value) {
  const edit = await ensureEdit(id);
  edit[field] = value;
  // Auto-mark visited when a date or notes are added and not explicitly unvisited.
  await putEdit(edit);
  return edit;
}

// ---- photos ------------------------------------------------------------------

function sanitizeName(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "photo") + (ext || ".jpg");
}

function uniqueName(existingNames, desired) {
  if (!existingNames.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let i = 1;
  let candidate;
  do {
    candidate = `${base}-${i}${ext}`;
    i++;
  } while (existingNames.has(candidate));
  return candidate;
}

// Downscale an image to a small JPEG thumbnail. Falls back to the original on failure.
async function makeThumb(file, max = 480, quality = 0.82) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch {
    return file;
  }
}

export async function addPhoto(id, file) {
  const edit = await ensureEdit(id);
  const existing = new Set(
    edit.photos.map((p) => (p.kind === "repo" ? p.full.split("/").pop() : p.name))
  );
  const name = uniqueName(existing, sanitizeName(file.name));
  const key = crypto.randomUUID();
  const thumb = await makeThumb(file);
  await tx("photos", "readwrite", (store) =>
    reqToPromise(store.put({ key, id, name, full: file, thumb }))
  );
  edit.photos.push({ kind: "local", key, name });
  await putEdit(edit);
  return edit;
}

export async function removePhoto(id, index) {
  const edit = await ensureEdit(id);
  const entry = edit.photos[index];
  if (!entry) return edit;
  if (entry.kind === "local") {
    await tx("photos", "readwrite", (store) => reqToPromise(store.delete(entry.key)));
    for (const variant of ["full", "thumb"]) {
      const cacheKey = entry.key + ":" + variant;
      const url = objectUrlCache.get(cacheKey);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrlCache.delete(cacheKey);
      }
    }
  }
  edit.photos.splice(index, 1);
  await putEdit(edit);
  return edit;
}

async function getBlob(key) {
  return tx("photos", "readonly", (store) => reqToPromise(store.get(key)));
}

// Resolve a photo entry to a displayable src. variant is "thumb" (grid) or "full" (lightbox).
export async function photoSrc(entry, variant = "full") {
  if (entry.kind === "repo") return variant === "thumb" ? entry.thumb : entry.full;
  const cacheKey = entry.key + ":" + variant;
  if (objectUrlCache.has(cacheKey)) return objectUrlCache.get(cacheKey);
  const rec = await getBlob(entry.key);
  if (!rec) return "";
  const blob = variant === "thumb" ? rec.thumb || rec.full : rec.full;
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(cacheKey, url);
  return url;
}

// ---- publish -----------------------------------------------------------------

export async function hasLocalEdits() {
  const count = await tx("edits", "readonly", (store) => reqToPromise(store.count()));
  return count > 0;
}

function isMeaningful(visit) {
  return visit.visited || visit.date || visit.notes || (visit.photos && visit.photos.length);
}

// Merge committed + local edits into the final visits.json and the new photo files.
async function buildPublish() {
  const visits = JSON.parse(JSON.stringify(committed.visits));
  const photoFiles = []; // {path, blob}

  const edits = await tx("edits", "readonly", (store) => reqToPromise(store.getAll()));
  for (const edit of edits) {
    const paths = [];
    for (const entry of edit.photos) {
      if (entry.kind === "repo") {
        paths.push({ full: entry.full, thumb: entry.thumb || entry.full });
      } else {
        const base = entry.name.replace(/\.[^.]+$/, "");
        const full = `photos/${edit.id}/${entry.name}`;
        const thumb = `photos/${edit.id}/thumb/${base}.jpg`;
        paths.push({ full, thumb });
        const rec = await getBlob(entry.key);
        if (rec) {
          photoFiles.push({ path: full, blob: rec.full });
          photoFiles.push({ path: thumb, blob: rec.thumb || rec.full });
        }
      }
    }
    const visit = {
      visited: !!edit.visited,
      date: edit.date || "",
      notes: edit.notes || "",
      photos: paths,
    };
    if (isMeaningful(visit)) {
      visits[edit.id] = visit;
    } else {
      delete visits[edit.id];
    }
  }

  return { json: { version: 1, visits }, photoFiles };
}

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// Path 1: write directly into the repo folder (Chrome/Edge File System Access API).
export function canSaveToFolder() {
  return typeof window.showDirectoryPicker === "function";
}

async function getDirHandle(root, parts) {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function writeFile(dirHandle, name, data) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function publishToFolder() {
  const root = await window.showDirectoryPicker({ mode: "readwrite" });
  const { json, photoFiles } = await buildPublish();

  const dataDir = await getDirHandle(root, ["data"]);
  await writeFile(dataDir, "visits.json", JSON.stringify(json, null, 2));

  for (const file of photoFiles) {
    const parts = file.path.split("/");
    const name = parts.pop();
    const dir = await getDirHandle(root, parts);
    await writeFile(dir, name, file.blob);
  }
  return { files: photoFiles.length + 1 };
}

// Path 2: download a ZIP to unzip into the repo root (works in all browsers).
export async function publishZip() {
  const { json, photoFiles } = await buildPublish();
  const encoder = new TextEncoder();
  const files = [{ name: "data/visits.json", data: encoder.encode(JSON.stringify(json, null, 2)) }];
  for (const file of photoFiles) {
    files.push({ name: file.path, data: await blobToBytes(file.blob) });
  }
  const blob = createZip(files);
  downloadBlob(blob, "dow-publish.zip");
  return { files: files.length };
}

export async function clearLocalEdits() {
  for (const url of objectUrlCache.values()) URL.revokeObjectURL(url);
  objectUrlCache.clear();
  await tx(["edits", "photos"], "readwrite", ([edits, photos]) => {
    edits.clear();
    photos.clear();
  });
}

// ---- metadata backup (export/import JSON) ------------------------------------

// Export merged visit metadata (no photo blobs) for plain backup.
export async function exportMetadata() {
  const { json } = await buildPublish();
  downloadBlob(
    new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }),
    "dow-visits-backup.json"
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
