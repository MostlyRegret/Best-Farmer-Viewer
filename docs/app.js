// docs/app.js
//
// Best Farmer Backup Viewer (ZIP + ranch.db + attachments)
// - Loads a backup ZIP locally (no upload)
// - Opens ranch.db using sql.js (WASM)
// - Tabs: Cattle / Feed / Inventory / Breeding
// - Inventory: pooled snapshot if available, otherwise legacy snapshot fallback
// - Search box filters the currently displayed table (Breeding filters Exposures table)
//
// Requirements in /docs alongside this file:
//   - index.html
//   - sql-wasm.js
//   - sql-wasm.wasm
//
// Uses JSZip from CDN in index.html

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

// For search filtering: we keep the *current* table rows/cols.
// NOTE: On Breeding tab, this is wired to the Exposures table (most useful).
let lastRenderedRows = [];
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

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
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

function setCountPill(filteredCount, totalCount) {
  if (totalCount === filteredCount) {
    countPillEl.textContent = `${totalCount} rows`;
  } else {
    countPillEl.textContent = `${filteredCount} / ${totalCount} rows`;
  }
}

async function blobUrlFromZipPath(path) {
  if (!path) return null;
  const entry = zipIndex.get(path);
  if (!entry) return null;

  const bytes = await entry.async("uint8array");

  const lower = path.toLowerCase();
  const mime =
    lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : lower.endsWith(".webp")
          ? "image/webp"
          : lower.endsWith(".pdf")
            ? "application/pdf"
            : "application/octet-stream";

  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}

/**
 * Renders a single table into the main view container.
 * Sets search/filter globals for that table.
 */
function renderTable(rows, { photoPathKey = null, extraColTitle = "Photo" } = {}) {
  lastRenderedRows = rows || [];
  lastRenderedPhotoCol = photoPathKey;

  if (!rows || rows.length === 0) {
    lastRenderedCols = [];
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

/**
 * Applies the search filter to the currently-rendered table
 * without re-querying the DB.
 */
function applySearchFilter() {
  const q = (searchEl.value || "").trim().toLowerCase();

  // Nothing rendered
  if (!lastRenderedRows.length || !lastRenderedCols.length) return;

  // No query -> re-render the full set we stored
  if (!q) {
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

  renderTable(filtered, { photoPathKey: lastRenderedPhotoCol });
  setCountPill(filtered.length, lastRenderedRows.length);
}

searchEl.addEventListener("input", () => applySearchFilter());

function setActiveTab(tab) {
  currentTab = tab;
  for (const btn of tabsEl.querySelectorAll("button.tabbtn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }

  // Clear search when switching tabs
  searchEl.value = "";
}

let tabsWired = false;
function wireTabsOnce() {
  if (tabsWired) return;
  tabsWired = true;

  tabsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button.tabbtn");
    if (!btn) return;
    const tab = btn.dataset.tab;
    await renderTab(tab);
  });
}

function fmtDate(ms) {
  if (!ms) return "";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return String(ms);

  // Your DB stores millis since epoch. Render as local date.
  try {
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return String(ms);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  } catch {
    return String(ms);
  }
}

function mapDateColumns(rows, cols) {
  // Replace common timestamp columns with YYYY-MM-DD for readability
  // (keeps values as strings for viewing/searching)
  const dateCols = new Set(cols.filter((c) =>
    c.endsWith("_date") || c === "date" || c.endsWith("_at") || c === "created_at"
  ));
  if (!dateCols.size) return rows;

  return rows.map((r) => {
    const out = { ...r };
    for (const c of dateCols) {
      if (out[c] != null && out[c] !== "") out[c] = fmtDate(out[c]);
    }
    return out;
  });
}

async function renderTab(tab) {
  setActiveTab(tab);

  try {
    if (tab === "cattle") {
      if (!hasTable("cattle")) {
        viewEl.innerHTML = `<div class="warn">This backup doesn’t have the cattle table.</div>`;
        setCountPill(0, 0);
        setStatus("Cattle table missing.", "warn");
        return;
      }

      let rows = queryAll(`
        SELECT id, ear_tag, status, sex, role, group_name, cohort, photo_path
        FROM cattle
        ORDER BY ear_tag ASC
      `);
      rows = mapDateColumns(rows, Object.keys(rows[0] || {}));

      renderTable(rows, { photoPathKey: "photo_path", extraColTitle: "Photo" });
      setStatus("Loaded Cattle.", "ok");
      return;
    }

    if (tab === "feed") {
      if (!hasTable("feed_entries") || !hasTable("feed_lots")) {
        viewEl.innerHTML = `<div class="warn">This backup doesn’t have feed tables yet.</div>`;
        setCountPill(0, 0);
        setStatus("Feed tables missing.", "warn");
        return;
      }

      let rows = queryAll(`
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

      rows = mapDateColumns(rows, Object.keys(rows[0] || {}));
      renderTable(rows);
      setStatus("Loaded Feed (recent first).", "ok");
      return;
    }

    if (tab === "inventory") {
      const hasPooled =
        hasTable("feed_inventory_pools") &&
        hasTable("feed_inventory_pool_txns") &&
        hasTable("feed_storages") &&
        hasTable("feed_lots");

      const hasLegacy =
        hasTable("feed_inventory_lots") &&
        hasTable("feed_inventory_txns") &&
        hasTable("feed_storages") &&
        hasTable("feed_lots");

      // -------------------------
      // Try POOLED snapshot first (V12+)
      // -------------------------
      if (hasPooled) {
        const pooledSnapshot = queryAll(`
          SELECT
            s.name AS storage,
            fl.name AS feed_type,
            fl.unit AS unit,
            ROUND(SUM(
              CASE UPPER(it.type)
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

        if (pooledSnapshot.length > 0) {
          renderTable(pooledSnapshot);
          setStatus("Loaded Inventory snapshot (pooled).", "ok");
          return;
        }
        // If pooled exists but empty, fall through to legacy.
      }

      // -------------------------
      // Fallback: LEGACY snapshot (V11 batches)
      // -------------------------
      if (hasLegacy) {
        const legacySnapshot = queryAll(`
          SELECT
            s.name AS storage,
            fl.name AS feed_type,
            fl.unit AS unit,
            ROUND(SUM(
              CASE UPPER(it.type)
                WHEN 'ADD' THEN it.qty
                WHEN 'REMOVE' THEN -it.qty
                WHEN 'ADJUST' THEN it.qty
                ELSE 0
              END
            ), 3) AS on_hand
          FROM feed_inventory_txns it
          JOIN feed_inventory_lots il ON il.id = it.lot_id
          JOIN feed_storages s ON s.id = il.storage_id
          JOIN feed_lots fl ON fl.id = il.feed_lot_id
          GROUP BY s.name, fl.name, fl.unit
          ORDER BY s.name ASC, fl.name ASC
        `);

        if (legacySnapshot.length > 0) {
          renderTable(legacySnapshot);
          setStatus("Loaded Inventory snapshot (legacy batches).", "ok");
          return;
        }
      }

      // -------------------------
      // Diagnostics if nothing to show
      // -------------------------
      const pooledCounts = hasPooled
        ? queryAll(`
            SELECT
              (SELECT COUNT(*) FROM feed_inventory_pools) AS pools,
              (SELECT COUNT(*) FROM feed_inventory_pool_txns) AS pool_txns
          `)[0]
        : { pools: 0, pool_txns: 0 };

      const legacyCounts = hasLegacy
        ? queryAll(`
            SELECT
              (SELECT COUNT(*) FROM feed_inventory_lots) AS lots,
              (SELECT COUNT(*) FROM feed_inventory_txns) AS txns
          `)[0]
        : { lots: 0, txns: 0 };

      viewEl.innerHTML = `
        <div class="warn">No inventory totals to show.</div>
        <div class="muted" style="margin-top:8px;">
          Pooled: <b>${escapeHtml(pooledCounts.pools)}</b> pools • <b>${escapeHtml(pooledCounts.pool_txns)}</b> txns<br/>
          Legacy: <b>${escapeHtml(legacyCounts.lots)}</b> lots • <b>${escapeHtml(legacyCounts.txns)}</b> txns
        </div>
        <div class="muted" style="margin-top:8px;">
          If you expect inventory here, add inventory in the app, then export a fresh backup.
        </div>
      `;
      setCountPill(0, 0);
      setStatus("Inventory: no totals available.", "warn");
      return;
    }

    if (tab === "breeding") {
      if (!hasTable("breeding_sessions") || !hasTable("breeding_exposures")) {
        viewEl.innerHTML = `<div class="warn">This backup doesn’t have breeding tables yet.</div>`;
        setCountPill(0, 0);
        setStatus("Breeding tables missing.", "warn");
        return;
      }

      // Sessions summary
      let sessions = queryAll(`
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
      sessions = mapDateColumns(sessions, Object.keys(sessions[0] || {}));

      // Exposures (recent) — this is what search will filter
      let exposures = queryAll(`
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
      exposures = mapDateColumns(exposures, Object.keys(exposures[0] || {}));

      // Render stacked sections
      viewEl.innerHTML = `
        <div class="pill">Sessions</div>
        <div id="sessionsHost" style="margin-top:10px;"></div>
        <div style="height:14px;"></div>
        <div class="pill">Exposures (most recent)</div>
        <div id="exposuresHost" style="margin-top:10px;"></div>
      `;

      const sessionsHost = document.getElementById("sessionsHost");
      const exposuresHost = document.getElementById("exposuresHost");

      // Render sessions into sessionsHost (simple table, no photos)
      if (!sessions.length) {
        sessionsHost.innerHTML = `<div class="muted">No sessions.</div>`;
      } else {
        const cols = Object.keys(sessions[0]);
        let t = "<table><thead><tr>";
        for (const c of cols) t += `<th>${escapeHtml(c)}</th>`;
        t += "</tr></thead><tbody>";
        for (const r of sessions) {
          t += "<tr>";
          for (const c of cols) t += `<td>${escapeHtml(r[c])}</td>`;
          t += "</tr>";
        }
        t += "</tbody></table>";
        sessionsHost.innerHTML = t;
      }

      // Render exposures into exposuresHost with photos
      if (!exposures.length) {
        exposuresHost.innerHTML = `<div class="muted">No exposures.</div>`;
        setCountPill(0, 0);
        setStatus("Loaded Breeding (no exposures).", "ok");
        // Update search globals to empty
        lastRenderedRows = [];
        lastRenderedCols = [];
        lastRenderedPhotoCol = null;
        return;
      }

      // Set search globals to exposures
      lastRenderedRows = exposures;
      lastRenderedCols = Object.keys(exposures[0]);
      lastRenderedPhotoCol = "cow_photo_path";
      setCountPill(exposures.length, exposures.length);

      // Build exposures table manually into exposuresHost so photos render from ZIP
      {
        const cols = lastRenderedCols;
        let h = "<table><thead><tr>";
        for (const c of cols) h += `<th>${escapeHtml(c)}</th>`;
        h += "<th>Photo</th></tr></thead><tbody>";

        for (const r of exposures) {
          h += "<tr>";
          for (const c of cols) h += `<td>${escapeHtml(r[c])}</td>`;
          const p = r.cow_photo_path;
          if (!p) h += `<td class="muted">—</td>`;
          else h += `<td><img class="thumb" data-photo="${escapeHtml(p)}" alt="photo"/></td>`;
          h += "</tr>";
        }

        h += "</tbody></table>";
        exposuresHost.innerHTML = h;

        void (async () => {
          const imgs = exposuresHost.querySelectorAll("img[data-photo]");
          for (const img of imgs) {
            const p = img.getAttribute("data-photo");
            const url = await blobUrlFromZipPath(p);
            if (url) img.src = url;
            else img.replaceWith(document.createTextNode("Missing"));
          }
        })();
      }

      setStatus("Loaded Breeding (sessions + exposures).", "ok");
      return;
    }

    // Unknown tab
    viewEl.innerHTML = `<div class="warn">Unknown tab: ${escapeHtml(tab)}</div>`;
    setCountPill(0, 0);
    setStatus("Unknown tab.", "warn");
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

  // Index entries for fast lookup (attachments)
  zipIndex = new Map();
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) zipIndex.set(relativePath, entry);
  });

  // Find ranch.db anywhere in zip by basename
  const dbEntry = [...zipIndex.entries()].find(
    ([name]) => name.split("/").pop() === "ranch.db"
  );
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

  wireTabsOnce();

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
