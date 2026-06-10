import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathsForStore, readCatalog } from "./catalog.mjs";

export async function exportCanvas(input = {}, options = {}) {
  const storePaths = pathsForStore(options.root);
  const outputPath = input.outputPath ?? path.join(storePaths.canvasDir, "grease.html");
  const catalog = await readCatalog(options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderHtml(catalog), "utf8");
  return {
    outputPath,
    itemCount: catalog.items.length
  };
}

export function catalogSignature(catalog) {
  return (catalog.items ?? []).map((item) => [
    item.id,
    item.status,
    item.severity,
    item.updatedAt,
    item.lastSeen,
    item.occurrenceCount,
    item.latestSummary,
    item.latestNote
  ].map((value) => String(value ?? "")).join("\u001f")).join("\u001e");
}

export function renderHtml(catalog) {
  const stats = computeStats(catalog.items);
  const rows = catalog.items.map((item) => `
    <article class="row severity-${escapeHtml(item.severity)} status-${escapeHtml(item.status)}" data-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">
      <label class="pick" aria-label="Select ${escapeHtml(item.title)}">
        <input type="checkbox" value="${escapeHtml(item.id)}">
      </label>
      <button class="row-main" type="button" data-open="${escapeHtml(item.id)}">
        <span class="row-top">
          <span class="row-title">${escapeHtml(item.title)}</span>
          <span class="badges">
            <span class="status-badge">${escapeHtml(item.status)}</span>
            <span class="severity">${escapeHtml(item.severity)}</span>
          </span>
        </span>
        <span class="summary">${escapeHtml(item.latestSummary || "")}</span>
        <span class="meta">
          <span>${item.occurrenceCount} occurrence${item.occurrenceCount === 1 ? "" : "s"}</span>
          <span>${escapeHtml(formatDate(item.lastSeen))}</span>
          <span title="${escapeHtml(originTitle(item))}">${escapeHtml(originLabel(item))}</span>
          ${item.status === "in-progress" ? `<span>${escapeHtml(staleLabel(item))}</span>` : ""}
        </span>
      </button>
      ${item.status === "ignored" ? "" : `<button class="delete-item" type="button" data-delete="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)}" title="Delete item">×</button>`}
    </article>
  `).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grease</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1017;
      --surface: #131722;
      --surface-2: #191f2d;
      --line: #252c3b;
      --line-strong: #374055;
      --text: #f6f7fb;
      --muted: #9ba6ba;
      --faint: #68748a;
      --gold: #f4c430;
      --gold-2: #ffe08a;
      --danger: #ff6b6b;
      --warn: #ff9f43;
      --medium: #f7c948;
      --low: #48d597;
      --radius: 18px;
      --shadow: 0 18px 60px rgba(0, 0, 0, .32);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(244, 196, 48, .12), transparent 34rem),
        linear-gradient(180deg, #111622 0%, var(--bg) 42%);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
    }

    .shell { width: min(1180px, 100%); margin: 0 auto; padding: 12px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(19, 23, 34, .86);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }

    .brand {
      color: var(--gold-2);
      font-size: 15px;
      font-weight: 900;
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: end;
    }
    .view-tabs {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(8, 11, 17, .74);
    }
    .view-tabs {
      display: grid;
      grid-template-columns: auto auto auto;
      gap: 4px;
      padding: 4px;
      min-width: 0;
    }
    .view-button {
      display: grid;
      gap: 2px;
      justify-items: start;
      min-width: 76px;
      padding: 6px 8px;
      border-radius: 10px;
      background: transparent;
      color: var(--muted);
    }
    .view-button strong { color: var(--text); font-size: 12px; }
    .view-button span { color: var(--faint); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .view-button.active {
      border-color: rgba(244, 196, 48, .72);
      background: linear-gradient(180deg, rgba(244, 196, 48, .18), rgba(244, 196, 48, .06));
      color: var(--gold-2);
    }
    .view-button.active strong, .view-button.active span { color: var(--gold-2); }
    .selection-tools, .request-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .selection-tools { justify-content: end; }
    button {
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      padding: 10px 12px;
      background: var(--surface-2);
      color: var(--text);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { border-color: var(--gold); }
    button.primary { background: var(--gold); color: #151000; border-color: transparent; }
    button:disabled { opacity: .42; cursor: not-allowed; }
    .icon-button {
      display: inline-grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 999px;
    }
    .icon-button svg { width: 16px; height: 16px; stroke: currentColor; }
    .status-badge { background: rgba(244, 196, 48, .15); color: var(--gold-2); }
    .status-resolved .status-badge { background: rgba(72, 213, 151, .14); color: var(--low); }
    .status-in-progress .status-badge { background: rgba(244, 196, 48, .18); color: var(--gold-2); }

    .content { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 12px; margin-top: 12px; align-items: start; }
    .list, .panel {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(19, 23, 34, .9);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, .025);
    }
    .panel h2 { margin: 0; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .updated { color: var(--faint); font-size: 12px; }
    .rows { display: grid; }

    .row {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) 42px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(90deg, var(--severity-color), var(--severity-color) 3px, transparent 3px);
    }
    .row:last-child { border-bottom: 0; }
    .row[hidden], .row.is-hidden, [hidden] { display: none !important; }
    .row:hover, .row.active { background-color: rgba(255, 255, 255, .035); }
    .row.selected { background-color: rgba(244, 196, 48, .08); }
    .row.status-in-progress { background-color: rgba(244, 196, 48, .035); }
    .row.status-resolved { opacity: .64; }
    .pick { display: grid; place-items: start center; padding-top: 15px; }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--gold); }
    .row-main {
      display: grid;
      gap: 6px;
      width: 100%;
      padding: 11px 12px 11px 0;
      text-align: left;
      background: transparent;
      border: 0;
      border-radius: 0;
      font-weight: 400;
    }
    .row-main:hover { border-color: transparent; }
    .delete-item {
      align-self: start;
      justify-self: center;
      width: 30px;
      height: 30px;
      margin-top: 10px;
      padding: 0;
      border-radius: 999px;
      color: var(--muted);
      background: rgba(255, 255, 255, .035);
    }
    .delete-item:hover {
      border-color: var(--danger);
      color: var(--danger);
      background: rgba(255, 107, 107, .1);
    }
    .row-top { display: flex; gap: 10px; align-items: start; justify-content: space-between; }
    .row-title { color: var(--text); font-weight: 800; font-size: 15px; line-height: 1.2; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: end; }
    .severity, .status-badge {
      flex: none;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .08);
      color: var(--text);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .summary {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: #cbd3e3;
      font-size: 13px;
    }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; color: var(--muted); font-size: 12px; }
    .meta span { padding: 3px 8px; border-radius: 999px; background: rgba(255, 255, 255, .045); }

    .panel { position: sticky; top: 12px; }
    .panel-body { padding: 12px; display: grid; gap: 12px; }
    .empty {
      display: grid;
      gap: 10px;
      min-height: 180px;
      align-content: center;
      color: var(--muted);
    }
    .list-empty { padding: 24px; }
    .empty strong { color: var(--text); font-size: 18px; }
    .detail { display: none; gap: 12px; }
    .detail.visible { display: grid; }
    .detail-title { margin: 0; font-size: 18px; line-height: 1.1; letter-spacing: -.02em; }
    .detail-summary { color: #d7deec; margin: 0; }
    textarea {
      width: 100%;
      min-height: 220px;
      resize: vertical;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background: #090c12;
      color: var(--text);
      padding: 12px;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .hidden { display: none; }
    .severity-critical { --severity-color: var(--danger); }
    .severity-high { --severity-color: var(--warn); }
    .severity-medium { --severity-color: var(--medium); }
    .severity-low { --severity-color: var(--low); }

    @media (max-width: 900px) {
      .shell { padding: 8px; }
      header { align-items: stretch; flex-direction: column; }
      .topbar { justify-content: stretch; }
      .selection-tools { justify-content: start; }
      .content { grid-template-columns: 1fr; }
      .panel { position: static; }
      .panel-head { align-items: start; flex-direction: column; }
    }

    @media print {
      body { background: white; color: black; }
      .topbar, .selection-tools, .pick, .panel { display: none; }
      .shell { width: 100%; padding: 0; }
      header, .list { box-shadow: none; border-color: #ccc; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">Grease</div>
      <div class="topbar">
        <nav class="view-tabs" aria-label="Catalog views">
          <button id="show-active" class="view-button filter active" data-filter="active" type="button">
            <strong>Active</strong>
            <span>${stats.active} items</span>
          </button>
          <button id="show-working" class="view-button filter" data-filter="working" type="button">
            <strong>Working</strong>
            <span>${stats.inProgress} items</span>
          </button>
          <button id="show-resolved" class="view-button filter" data-filter="resolved" type="button">
            <strong>Resolved</strong>
            <span>${stats.resolved} items</span>
          </button>
        </nav>
        <div class="selection-tools" aria-label="Catalog status">
          <button id="refresh-page" class="icon-button" type="button" aria-label="Refresh catalog" title="Refresh catalog">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
              <path d="M21 3v6h-6"></path>
            </svg>
          </button>
          <span id="refresh-status" class="updated" role="status">Live</span>
        </div>
      </div>
    </header>

    <main class="content">
      <section class="list" aria-label="Friction items">
        <div class="rows" id="rows">
          ${rows || `<div class="empty list-empty"><strong>No friction captured yet.</strong><span>Grease will add local tool and MCP failures here as they happen.</span></div>`}
        </div>
      </section>

      <aside id="fix-panel" class="panel" aria-label="Session request" tabindex="-1">
        <div class="panel-head">
          <div>
            <h2>Fix session</h2>
            <span id="panel-count" class="updated">No selection</span>
          </div>
        </div>
        <div class="panel-body">
          <div id="empty" class="empty">
            <strong>Select friction to fix.</strong>
            <span>Pick one item for a targeted session, or select several to address a related cluster.</span>
          </div>
          <div id="request" class="detail">
            <h3 id="request-title" class="detail-title"></h3>
            <p class="detail-summary">Use this prompt to create a Copilot project session.</p>
            <textarea id="request-prompt" readonly></textarea>
            <div class="request-actions">
              <button id="run-current" class="primary" type="button">Run in current session</button>
              <button id="copy" type="button">Copy prompt</button>
            </div>
            <p id="run-status" class="detail-summary"></p>
          </div>
        </div>
      </aside>
    </main>
  </div>

  <script type="application/json" id="grease-data">${escapeScriptJson(JSON.stringify(catalog.items))}</script>
  <script>
    let items = JSON.parse(document.getElementById('grease-data').textContent);
    const initialCatalogSignature = ${JSON.stringify(catalogSignature(catalog))};
    const byId = new Map(items.map((item) => [item.id, item]));
    const rows = [...document.querySelectorAll('.row')];
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
    const panelCount = document.getElementById('panel-count');
    const empty = document.getElementById('empty');
    const request = document.getElementById('request');
    const requestTitle = document.getElementById('request-title');
    const requestPrompt = document.getElementById('request-prompt');
    const fixPanel = document.getElementById('fix-panel');
    const refreshStatus = document.getElementById('refresh-status');
    const copyButton = document.getElementById('copy');
    const runButton = document.getElementById('run-current');
    let currentFilter = savedFilter();
    let requestVersion = 0;

    function selectedIds() {
      return checkboxes.filter((box) => box.checked).map((box) => box.value);
    }

    function refreshSelection() {
      const ids = selectedIds();
      panelCount.textContent = ids.length ? ids.length + ' selected' : 'No selection';
      for (const row of rows) {
        const box = row.querySelector('input[type="checkbox"]');
        row.classList.toggle('selected', box.checked);
      }
      if (ids.length > 0) {
        showRequestForSelection(ids);
      } else {
        showEmpty();
      }
    }

    function showEmpty() {
      requestVersion++;
      empty.classList.remove('hidden');
      request.classList.remove('visible');
      requestTitle.textContent = '';
      requestPrompt.value = '';
      copyButton.disabled = true;
      runButton.disabled = true;
      for (const row of rows) row.classList.remove('active');
    }

    async function showRequestForSelection(ids) {
      const version = ++requestVersion;
      const selected = ids.map((id) => byId.get(id)).filter(Boolean);
      empty.classList.add('hidden');
      request.classList.add('visible');
      requestTitle.textContent = titleFor(selected);
      requestPrompt.value = 'Preparing session request...';
      copyButton.disabled = true;
      runButton.disabled = false;
      document.getElementById('run-status').textContent = '';
      for (const row of rows) row.classList.toggle('active', ids.includes(row.dataset.id));
      try {
        const response = await postJson('/session-request', { ids });
        if (version !== requestVersion) return;
        requestTitle.textContent = response.data.title;
        requestPrompt.value = response.data.prompt;
        const hasActiveItems = response.data.itemCount > 0;
        copyButton.disabled = !hasActiveItems;
        runButton.disabled = !hasActiveItems;
        if (!hasActiveItems) {
          document.getElementById('run-status').textContent = 'Selected items are already closed. Refresh the canvas.';
        }
      } catch (error) {
        if (version !== requestVersion) return;
        requestPrompt.value = 'Grease failed to prepare the session request: ' + error.message;
        copyButton.disabled = true;
        runButton.disabled = true;
      }
    }

    function titleFor(selected) {
      if (selected.length === 1) return 'Fix ' + selected[0].title;
      return 'Fix ' + selected.length + ' Grease items starting with ' + selected[0].title;
    }

    function visibleByStatus(item) {
      if (currentFilter === 'resolved') return item.status === 'resolved' || item.status === 'ignored';
      if (currentFilter === 'working') return item.status === 'in-progress';
      return item.status !== 'resolved' && item.status !== 'ignored';
    }

    function applyFilters() {
      for (const row of rows) {
        const item = byId.get(row.dataset.id);
        const visible = visibleByStatus(item);
        row.hidden = !visible;
        row.classList.toggle('is-hidden', !visible);
        if (!visible) row.querySelector('input[type="checkbox"]').checked = false;
      }
      for (const button of document.querySelectorAll('.filter')) {
        button.classList.toggle('active', button.dataset.filter === currentFilter);
      }
      refreshSelection();
    }

    for (const box of checkboxes) box.addEventListener('change', refreshSelection);
    for (const button of document.querySelectorAll('[data-open]')) {
      button.addEventListener('click', () => {
        const row = button.closest('.row');
        const box = row.querySelector('input[type="checkbox"]');
        if (!box.checked) {
          for (const other of checkboxes) other.checked = false;
          box.checked = true;
          refreshSelection();
        }
        focusFixPanel();
      });
    }

    for (const button of document.querySelectorAll('.filter')) {
      button.addEventListener('click', () => {
        currentFilter = button.dataset.filter;
        window.sessionStorage.setItem('grease-filter', currentFilter);
        applyFilters();
      });
    }

    document.getElementById('refresh-page').addEventListener('click', () => {
      window.location.reload();
    });

    for (const button of document.querySelectorAll('[data-delete]')) {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        await deleteItem(button.dataset.delete);
      });
    }

    async function pollCatalogForChanges() {
      if (document.visibilityState === 'hidden') {
        return;
      }
      try {
        const response = await fetch('/catalog.json', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('catalog refresh returned ' + response.status);
        }
        const payload = await response.json();
        if (payload.ok && payload.data.signature !== initialCatalogSignature) {
          refreshStatus.textContent = 'Catalog changed. Refreshing.';
          window.location.reload();
          return;
        }
        refreshStatus.textContent = 'Live';
      } catch (error) {
        refreshStatus.textContent = 'Refresh paused: ' + error.message;
      }
    }

    document.getElementById('copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(requestPrompt.value);
      document.getElementById('run-status').textContent = 'Copied prompt.';
    });

    document.getElementById('run-current').addEventListener('click', async () => {
      const ids = selectedIds();
      if (ids.length === 0) {
        showEmpty();
        return;
      }
      const status = document.getElementById('run-status');
      status.textContent = 'Sending prompt to the current session...';
      try {
        const response = await postJson('/run-current-session', { ids });
        status.textContent = 'Sent to current session. ' + response.data.itemCount + ' item' + (response.data.itemCount === 1 ? '' : 's') + ' marked in-progress.';
        markRowsInProgress(response.data.itemIds);
      } catch (error) {
        status.textContent = 'Could not run in current session: ' + error.message;
      }
    });

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error || 'Unknown Grease error');
      return payload;
    }

    async function deleteItem(id) {
      refreshStatus.textContent = 'Deleting item...';
      try {
        const response = await postJson('/delete-item', { id });
        const item = byId.get(response.data.id);
        if (item) {
          item.status = 'ignored';
          item.updatedAt = new Date().toISOString();
          item.latestNote = 'Deleted from the Grease canvas.';
        }
        const row = document.querySelector('[data-id="' + CSS.escape(response.data.id) + '"]');
        if (row) {
          const box = row.querySelector('input[type="checkbox"]');
          if (box) box.checked = false;
          row.dataset.status = 'ignored';
          row.classList.remove('status-open', 'status-triaged', 'status-in-progress', 'status-resolved');
          row.classList.add('status-ignored');
          row.querySelector('[data-delete]')?.remove();
          const badge = row.querySelector('.status-badge');
          if (badge) badge.textContent = 'ignored';
        }
        refreshStatus.textContent = 'Deleted item';
        applyFilters();
      } catch (error) {
        refreshStatus.textContent = 'Delete failed: ' + error.message;
      }
    }

    function focusFixPanel() {
      request.scrollIntoView({ behavior: 'auto', block: 'start', inline: 'nearest' });
      requestTitle.setAttribute('tabindex', '-1');
      requestTitle.focus();
    }

    function markRowsInProgress(ids) {
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) continue;
        item.status = 'in-progress';
        item.updatedAt = new Date().toISOString();
        const row = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
        if (!row) continue;
        row.dataset.status = 'in-progress';
        row.classList.remove('status-open', 'status-triaged', 'status-resolved', 'status-ignored');
        row.classList.add('status-in-progress');
        const badge = row.querySelector('.status-badge');
        if (badge) badge.textContent = 'in-progress';
      }
      applyFilters();
    }

    function savedFilter() {
      const value = window.sessionStorage.getItem('grease-filter');
      return ['active', 'working', 'resolved'].includes(value) ? value : 'active';
    }

    applyFilters();
    window.setInterval(pollCatalogForChanges, 4000);
  </script>
</body>
</html>
`;
}

function computeStats(items) {
  const active = items.filter((item) => item.status !== "resolved" && item.status !== "ignored");
  return {
    active: active.length,
    inProgress: active.filter((item) => item.status === "in-progress").length,
    high: active.filter((item) => item.severity === "high" || item.severity === "critical").length,
    resolved: items.filter((item) => item.status === "resolved" || item.status === "ignored").length
  };
}

function originLabel(item) {
  const machine = firstNonEmpty(item.machineNames) ?? firstNonEmpty((item.origins ?? []).map((origin) => origin.machineName));
  const session = firstNonEmpty(item.sessionNames) ?? firstNonEmpty((item.origins ?? []).map((origin) => origin.sessionName));
  if (machine && session) {
    return `${machine} · ${session}`;
  }
  if (machine) {
    return machine;
  }
  if (session) {
    return session;
  }
  const sessionId = firstNonEmpty(item.sessionIds);
  return sessionId ? `session ${sessionId.slice(0, 8)}` : "unknown origin";
}

function originTitle(item) {
  const origins = item.origins ?? [];
  if (origins.length === 0) {
    return originLabel(item);
  }
  return origins.map((origin) => {
    const machine = origin.machineName ?? "unknown machine";
    const session = origin.sessionName ?? (origin.sessionId ? `session ${String(origin.sessionId).slice(0, 8)}` : "unknown session");
    return `${machine} · ${session}`;
  }).join("\n");
}

function firstNonEmpty(values = []) {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim();
}

function staleLabel(item) {
  if (!item.updatedAt) {
    return "retry if stale";
  }
  const updated = new Date(item.updatedAt).getTime();
  if (Number.isNaN(updated)) {
    return "retry if stale";
  }
  const ageMinutes = Math.floor((Date.now() - updated) / 60000);
  if (ageMinutes >= 60) {
    return `stale ${Math.floor(ageMinutes / 60)}h`;
  }
  if (ageMinutes >= 10) {
    return `stale ${ageMinutes}m`;
  }
  return "working";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value ?? "");
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeScriptJson(value) {
  return value
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
