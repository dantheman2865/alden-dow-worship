# Alden B. Dow Houses of Worship — Bucket-List Map

An interactive map of the 27 religious buildings designed by architect **Alden B. Dow**,
with the ability to mark each as *visited* and attach your own photos. Built as a
**static site** — deployable to GitHub Pages with no server.

## How it works

The site has two layers:

- **Committed layer (what everyone sees):** the research data in
  `alden_dow_religious_buildings.json`, your visit log in `data/visits.json`, and photo
  files under `photos/<id>/`. These live in the repo and are served verbatim.
- **Local editor (only on your machine):** an *Edit mode* in the browser stages your
  visited-marks, dates, notes, and photo uploads in the browser's IndexedDB. Since a
  static page can't write to git, you **publish** those edits back into the repo, then
  commit them.

## Running locally

A static server is required (opening `index.html` via `file://` blocks `fetch`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Logging a visit

1. Toggle **Edit mode** (top right). A publish bar appears.
2. Click a building (on the map or in the list) to open its panel.
3. Check **Mark as visited**, set a date, add notes, and drag in photos.
4. Publish your changes (see below), then commit.

## Publishing changes back to the repo

In the publish bar (visible in Edit mode):

- **Save to repo folder** *(Chrome/Edge)* — pick this repo's folder once; it writes
  `data/visits.json` and your new photos straight into `photos/<id>/`. Seamless.
- **Download publish zip** *(any browser)* — produces `dow-publish.zip`. Unzip it into
  the repo root; it contains the updated `data/visits.json` and your photos.
- **Backup JSON** — downloads just the visit metadata (no photos) for safekeeping.
- **Clear local edits** — wipes the browser staging area. Only do this **after** you've
  published *and* committed, or you'll lose unsaved work.

Then commit:

```bash
git add data/visits.json photos/
git commit -m "Add visit: <building>"
git push
```

Reload the site after committing — your visit now renders from the committed layer, and
the local staging area can be cleared.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Source: deploy from branch, root of your default branch.
3. The included `.nojekyll` ensures the `js/` and `data/` folders are served as-is.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | App shell |
| `css/styles.css` | Styling |
| `js/app.js` | Map, list, detail panel, editor wiring |
| `js/store.js` | IndexedDB working copy, merge, publish logic |
| `js/zip.js` | Dependency-free ZIP builder (publish fallback) |
| `alden_dow_religious_buildings.json` | Research data (source of truth, unchanged) |
| `data/visits.json` | Committed visit log |
| `photos/<id>/` | Committed photos, keyed by building id |

Building ids are generated deterministically from `year + structure_name + location`,
so the research file never needs editing.

## Notes

- Two records (Ward Memorial, Livonia; Kalamazoo Christian) have no confirmed
  coordinates and are shown in the list with a *location unverified* tag rather than on
  the map.
- Photos committed here are **public** — that's the intended trade-off for a shareable
  site.
- Map tiles: OpenStreetMap via Leaflet (no API key, no billing).
