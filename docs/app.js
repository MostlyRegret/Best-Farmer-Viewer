
const statusEl = document.getElementById("status");
const inputEl = document.getElementById("zip");
const cattleEl = document.getElementById("cattle");

let zipIndex = null; // Map<zipPath, JSZipObject>
let db = null;

function setStatus(s) {
  statusEl.textContent = s;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function blobUrlFromZipPath(path) {
  if (!path) return null;
  const entry = zipIndex.get(path);
  if (!entry) return null;

  const bytes = await entry.async("uint8array");
  // naive mime guess
  const lower = path.toLowerCase();
  const mime =
    lower.endsWith(".png") ? "image/png" :
    lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" :
    lower.endsWith(".webp") ? "image/webp" :
    lower.endsWith(".pdf") ? "application/pdf" :
    "application/octet-stream";

  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}

function renderTable(container, rows, extraColBuilder) {
  if (!rows.length) {
    container.innerHTML = `<div class="muted">No rows.</div>`;
    return;
  }
  const cols = Object.keys(rows[0]);

  let html = "<table><thead><tr>";
  for (const c of cols) html += `<th>${escapeHtml(c)}</th>`;
  if (extraColBuilder) html += "<th>Photo</th>";
  html += "</tr></thead><tbody>";

  for (const r of rows) {
    html += "<tr>";
    for (const c of cols) html += `<td>${escapeHtml(r[c])}</td>`;
    if (extraColBuilder) html += `<td>${extraColBuilder(r) ?? ""}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  container.innerHTML = html;
}

async function renderCattle() {
  // Adjust columns to your real schema as you like
  const rows = queryAll(`
    SELECT id, ear_tag, status, sex, role, group_name, cohort, photo_path
    FROM cattle
    ORDER BY ear_tag ASC
    LIMIT 200
  `);

  renderTable(cattleEl, rows, (r) => {
    // placeholder img tag; we’ll fill it async after table is placed
    if (!r.photo_path) return `<span class="muted">—</span>`;
    const safe = escapeHtml(r.photo_path);
    return `<img data-photo="${safe}" alt="photo"/>`;
  });

  // fill photo blobs
  const imgs = cattleEl.querySelectorAll("img[data-photo]");
  for (const img of imgs) {
    const p = img.getAttribute("data-photo");
    const url = await blobUrlFromZipPath(p);
    if (url) img.src = url;
    else img.replaceWith(document.createTextNode("Missing"));
  }
}

async function loadFromZipFile(file) {
  setStatus("Reading zip…");
  const bytes = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);

  // index entries for fast lookup (attachments)
  zipIndex = new Map();
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) zipIndex.set(relativePath, entry);
  });

  // find ranch.db anywhere in zip by basename
  const dbEntry = [...zipIndex.entries()].find(([name]) => name.split("/").pop() === "ranch.db");
  if (!dbEntry) throw new Error("ZIP missing ranch.db");

  setStatus("Loading ranch.db into SQLite (WASM)…");
  const dbBytes = await dbEntry[1].async("uint8array");

  // init sql.js (expects sql-wasm.wasm beside sql-wasm.js)
  const SQL = await initSqlJs({ locateFile: (f) => `./${f}` });
  db = new SQL.Database(dbBytes);

  setStatus("Querying…");
  await renderCattle();

  setStatus("Loaded. (All local, nothing uploaded.)");
}

inputEl.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    await loadFromZipFile(file);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`);
  }
});
