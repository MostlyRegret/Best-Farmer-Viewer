const statusEl = document.getElementById("status");
const inputEl = document.getElementById("zip");
const tabsEl = document.getElementById("tabs");
const toolbarEl = document.getElementById("toolbar");
const viewCardEl = document.getElementById("viewCard");
const viewEl = document.getElementById("view");
const searchEl = document.getElementById("search");
const countPillEl = document.getElementById("countPill");

let zipIndex = null; // Map<zipPath, JSZipObject>
let db = null;
let currentTab = "cattle";
let lastRenderedRows = []; // for search filtering
let lastRenderedCols = [];
let lastRenderedPhotoCol = null;

function setStatus(text, cls = "") {
  statusEl.className = cls ? cls : "muted";
  statusEl.textContent = text;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hasTable(tableName) {
  try {
    const rows = queryAll(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [tableName]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
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

function setCountPill(filteredCount, totalCount) {
  if (totalCount === filteredCount) {
    countPillEl.textContent = `${totalCount} rows`;
  } else {
    countPillEl.textContent = `${filteredCount} / ${totalCount} rows`;
  }
}

function renderTable(rows, { photoPathKey = null, extraColTitle = "Photo" } = {}) {
  lastRenderedRows = rows;
  lastRenderedPhotoCol = photoPathKey;

  if (!rows || rows.length === 0) {
    viewEl.innerHTML = `<div class="muted">No rows.</div>`;
    setCountPill(0, 0);
    return;
  }

  const cols = Object.keys(rows[0]);
  lastRenderedCols = cols;

  let html = "<table><thead><tr>";
  for (const c of cols) html += `<th>${escapeHtml(c)}</th>`;
  if (photoPathKey) html += `<th>${escapeHtml(extraColTitle)}</th>`;
  html += "</tr></thead><tbody>";

  for (const r of rows) {
    html += "<tr>";
    for (const c of cols) html += `<td>${escapeHtml(r[c])}</td>`;
    if (photoPathKey) {
      const p = r[photoPathKey];
      if (!p) {
        html += `<td class="muted">—</td>`;
      } else {
        html += `<td><img class="thumb" data-photo="${escapeHtml(p)}" alt="photo"/></td>`;
      }
    }
    html += "</tr>";
  }

  html += "</tbody></table>";
  viewEl.innerHTML = html;

  // Search: initial count
  setCountPill(rows.length, rows.length);

  // Fill photo blobs async
  if (photoPathKey) {
    void (async () => {
      const imgs = viewEl.querySelectorAll("img[data-photo]");
      for (const img of imgs) {
        const p = img.getAttribute("data-photo");
        const url = await blobUrlFromZipPath(p);
        if (url) img.src = url;
        else img.replaceWith(document.createTextNode("Missing"));
      }
    })();
  }
}

function applySearchFilter() {
  const q = (searchEl.value || "").trim().toLowerCase();
  if (!lastRenderedRows.length) return;

  if (!q) {
    // re-render original without re-query
    renderTable(lastRenderedRows, { photoPathKey: lastRenderedPhotoCol });
    return;
  }

  const filtered = lastRenderedRows.filter((r) => {
    for (const c of lastRenderedCols) {
      const v = r[c];
      if (v == null) continue;
      if (String(v).toLowerCase().includes(q)) return true;
    }
    return false;
  });

  // Render filtered
  renderTable(filtered, { photoPathKey: lastRenderedPhotoCol });
  setCountPill(filtered.length, lastRenderedRows.length);
}

searchEl.addEventListener("input", () => applySearchFilter());

function setActiveTab(tab) {
  currentTab = tab;
  for (const btn of tabsEl.querySelectorAll("button.tabbtn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  // clear search when switching tabs
  searchEl.value = "";
}

function wireTabs() {
  tabsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button.tabbtn");
    if (!btn) return;
    const tab = btn.dataset.tab;
    await renderTab(tab);
  });
}

async function renderTab(tab) {
  setActiveTab(tab);

  try {
    if (tab === "cattle") {
      const rows = queryAll(`
        SELECT id, ear_tag, status, sex, role, group_name, cohort, photo_path
        FROM cattle
        ORDER BY ear_tag ASC
      `);
      renderTable(rows, { photoPathKey: "photo_path", extraColTitle: "Photo" });
      setStatus("Loaded Cattle.", "ok");
      return;
    }

    if (tab === "feed") {
      // feed_entries + feed_lots
      if (!hasTable("feed_entries") || !hasTable("feed_lots")) {
        viewEl.innerHTML = `<div class="warn">This backup doesn’t have feed tables yet.</div>`;
        setCountPill(0, 0);
        return;
      }

      const rows = queryAll(`
        SELECT
          fe.date,
          fe.group_name,
          fl.name AS feed_type,
          fe.amount,
          fl.unit,
          fl.cost_per_unit
        FROM feed_entries fe
        JOIN feed_lots fl ON fl.id = fe.feed_lot_id
        ORDER BY fe.date DESC
        LIMIT 2000
      `);

      renderTable(rows);
      setStatus("Loaded Feed (recent first).", "ok");
      return;
    }

    if (tab === "inventory") {
      // pooled inventory snapshot (V12)
      if (!hasTable("feed_inventory_pools") || !hasTable("feed_inventory_pool_txns")) {
        viewEl.innerHTML = `<div class="warn">
          This backup doesn’t have pooled inventory tables (V12).<br/>
          If you still have legacy inventory, we can add a legacy view too.
        </div>`;
        setCountPill(0, 0);
        return;
      }

      const rows = queryAll(`
        SELECT
          s.name AS storage,
          fl.name AS feed_type,
          fl.unit AS unit,
          ROUND(SUM(
            CASE it.type
              WHEN 'ADD' THEN it.qty
              WHEN 'REMOVE' THEN -it.qty
              WHEN 'ADJUST' THEN it.qty
              ELSE 0
            END
          ), 3) AS on_hand
        FROM feed_inventory_pool_txns it
        JOIN feed_inventory_pools p ON p.id = it.pool_id
        JOIN feed_storages s ON s.id = p.storage_id
        JOIN feed_lots fl ON fl.id = p.feed_lot_id
        GROUP BY s.name, fl.name, fl.unit
        ORDER BY s.name ASC, fl.name ASC
      `);

      renderTable(rows);
      setStatus("Loaded Inventory snapshot (pooled).", "ok");
      return;
    }

    if (tab === "breeding") {
      if (!hasTable("breeding_sessions") || !hasTable("breeding_exposures")) {
        viewEl.innerHTML = `<div class="warn">This backup doesn’t have breeding tables yet.</div>`;
        setCountPill(0, 0);
        return;
      }

      // Sessions summary
      const sessions = queryAll(`
        SELECT
          group_name,
          start_date,
          end_date,
          gestation_days,
          notes
        FROM breeding_sessions
        ORDER BY start_date DESC
        LIMIT 200
      `);

      // Exposures (recent)
      const exposures = queryAll(`
        SELECT
          session_id,
          cow_tag,
          cow_status,
          exposed,
          observed_breeding_date,
          preg_check_date,
          preg_result,
          due_date,
          notes,
          cow_photo_path
        FROM breeding_exposures
        ORDER BY created_at DESC
        LIMIT 500
      `);

      // Render both tables stacked
      let html = `<div class="pill">Sessions</div>`;
      viewEl.innerHTML = html;
      // First table
      const tmp1 = document.createElement("div");
      viewEl.appendChild(tmp1);
      // temporary swap render target
      const prev = viewEl.innerHTML;

      // render sessions into tmp1
      (function renderInto(el, rows) {
        if (!rows.length) {
          el.innerHTML = `<div class="muted">No sessions.</div>`;
          return;
        }
        const cols = Object.keys(rows[0]);
        let t = "<table><thead><tr>";
        for (const c of cols) t += `<th>${escapeHtml(c)}</th>`;
        t += "</tr></thead><tbody>";
        for (const r of rows) {
          t += "<tr>";
          for (const c of cols) t += `<td>${escapeHtml(r[c])}</td>`;
          t += "</tr>";
        }
        t += "</tbody></table>";
        el.innerHTML = t;
      })(tmp1, sessions);

      const sep = document.createElement("div");
      sep.style.marginTop = "14px";
      sep.innerHTML = `<div class="pill">Exposures (most recent)</div>`;
      viewEl.appendChild(sep);

      const tmp2 = document.createElement("div");
      viewEl.appendChild(tmp2);

      // exposures with photos
      if (!exposures.length) {
        tmp2.innerHTML = `<div class="muted">No exposures.</div>`;
        setCountPill(0, 0);
        return;
      }
      // Use normal renderer for exposures
      // (set globals for search to exposures table only)
      tmp2.innerHTML = "";
      // Hijack: render exposures into tmp2 by temporarily pointing viewEl
      const oldView = viewEl;
      // We'll render via helper that writes to a given element
      const renderTableInto = (el, rows, photoKey) => {
        lastRenderedRows = rows;
        lastRenderedPhotoCol = photoKey;
        lastRenderedCols = Object.keys(rows[0] || {});

        let cols = lastRenderedCols;
        let h = "<table><thead><tr>";
        for (const c of cols) h += `<th>${escapeHtml(c)}</th>`;
        h += "<th>Photo</th></tr></thead><tbody>";

        for (const r of rows) {
          h += "<tr>";
          for (const c of cols) h += `<td>${escapeHtml(r[c])}</td>`;
          const p = r[photoKey];
          if (!p) h += `<td class="muted">—</td>`;
          else h += `<td><img class="thumb" data-photo="${escapeHtml(p)}" alt="photo"/></td>`;
          h += "</tr>";
        }
        h += "</tbody></table>";
        el.innerHTML = h;

        void (async () => {
          const imgs = el.querySelectorAll("img[data-photo]");
          for (const img of imgs) {
            const p = img.getAttribute("data-photo");
            const url = await blobUrlFromZipPath(p);
            if (url) img.src = url;
            else img.replaceWith(document.createTextNode("Missing"));
          }
        })();

        setCountPill(rows.length, rows.length);
      };

      renderTableInto(tmp2, exposures, "cow_photo_path");
      setStatus("Loaded Breeding (sessions + exposures).", "ok");
      return;
    }
  } catch (err) {
    console.error(err);
    setStatus(`Error rendering ${tab}: ${err.message || err}`, "err");
    viewEl.innerHTML = `<div class="err">Error: ${escapeHtml(err.message || err)}</div>`;
    setCountPill(0, 0);
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

  // Show UI
  tabsEl.style.display = "";
  toolbarEl.style.display = "";
  viewCardEl.style.display = "";
  wireTabs();

  // Default tab
  await renderTab("cattle");

  setStatus("Loaded. (All local, nothing uploaded.)", "ok");
}

inputEl.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    await loadFromZipFile(file);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`, "err");
  }
});
