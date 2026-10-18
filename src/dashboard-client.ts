// Static dashboard behaviour. Served as /assets/dashboard.js (no inline handlers).
export const DASHBOARD_JS = `
(() => {
  const PROJECT_KEY = "status-hub:project";
  const LANE_KEY = "status-hub:lanes";
  const GROUP_KEY = "status-hub:groups";
  const VIEW_KEY = "status-hub:view";
  const body = document.body;
  if (!body || !body.classList.contains("app")) return;

  const page = body.dataset.page || "";
  let applyingLanes = false;
  let drawerSilent = false;
  let switcherIndex = 0;
  const TAB_KEY = "status-hub:task-tab";
  const TABS = ["overview", "timeline", "history", "blockers"];

  function knownTab(value) {
    return TABS.indexOf(value) !== -1 ? value : "";
  }
  function rememberedTab() {
    return knownTab(storageGet(TAB_KEY) || "") || "overview";
  }
  function applyTaskTab(root, writeUrl) {
    if (!root) return "overview";
    const urlTab = knownTab(new URLSearchParams(location.search).get("tab") || "");
    const name = urlTab || rememberedTab();
    root.querySelectorAll("[role='tab']").forEach((tab) => {
      const on = tab.getAttribute("data-tab") === name;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      const on = panel.getAttribute("data-tab-panel") === name;
      panel.classList.toggle("is-on", on);
      if (on) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
    storageSet(TAB_KEY, name);
    if (writeUrl && location.pathname.indexOf("/t/") === 0) {
      const url = new URL(location.href);
      if (url.searchParams.get("tab") !== name) {
        url.searchParams.set("tab", name);
        url.searchParams.delete("fragment");
        history.replaceState(history.state, "", url.pathname + "?" + url.searchParams.toString());
      }
    }
    const full = document.getElementById("drawer-full");
    if (full instanceof HTMLAnchorElement && full.pathname.indexOf("/t/") === 0) {
      full.search = "?tab=" + encodeURIComponent(name);
    }
    return name;
  }
  function escText(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function prShortLabel(href) {
    const match = /\\/pulls?\\/(\\d+)(?:[/?#]|$)/i.exec(href);
    if (match) return "#" + match[1];
    try {
      const last = new URL(href).pathname.split("/").filter(Boolean).pop() || "";
      if (/^\\d+$/.test(last)) return "#" + last;
    } catch (err) { /* use the full href */ }
    return href;
  }
  function externalHtml(href, label) {
    const safe = escText(href);
    const text = escText(label || href);
    if (!/^https?:\\/\\//i.test(href)) return text;
    const tip = label && label !== href ? ' title="' + safe + '"' : "";
    return '<a href="' + safe + '"' + tip + ' target="_blank" rel="noopener noreferrer">' + text + '<span class="ext-icon"><svg class="ext" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5H2.5v7h7V7.5M6.5 2.5h3v3M9.5 2.5 5.5 6.5"/></svg><span class="sr"> (opens in a new tab)</span></span></a>';
  }
  function paintValue(form, value) {
    const slot = form.querySelector(".ie-value");
    if (!slot) return;
    const kind = form.getAttribute("data-inline-kind") || "text";
    if (!value) {
      slot.textContent = "—";
      return;
    }
    if (kind === "url") {
      const short = form.closest("table.tasks") ? prShortLabel(value) : "";
      slot.innerHTML = externalHtml(value, short && short !== value ? short : "");
    }
    else if (kind === "links") {
      const parts = value.split(/\\s+/).filter(Boolean);
      slot.innerHTML = parts.length ? parts.map(externalHtml).join("<br>") : "—";
    } else slot.textContent = value;
  }
  function closeEdit(form, restore) {
    form.classList.remove("is-editing", "is-saving");
    const view = form.querySelector(".ie-view");
    const editor = form.querySelector(".ie-form");
    const msg = form.querySelector(".ie-msg");
    if (view) view.hidden = false;
    if (editor) editor.hidden = true;
    if (msg) msg.textContent = "";
    if (restore) {
      const field = form.querySelector("input, select, textarea");
      if (field && field.hasAttribute("data-original")) field.value = field.getAttribute("data-original") || "";
    }
  }
  function editForm(node) {
    const id = node.getAttribute("data-inline-target");
    if (id) {
      const found = document.getElementById(id);
      if (found) return found;
    }
    return node.closest("[data-inline-edit]");
  }
  function openEdit(form) {
    form.classList.add("is-editing");
    const view = form.querySelector(".ie-view");
    const editor = form.querySelector(".ie-form");
    if (view) view.hidden = true;
    if (editor) editor.hidden = false;
    const field = form.querySelector("input, select, textarea");
    if (field instanceof HTMLElement) field.focus();
    if (form.getAttribute("data-inline-kind") === "markdown" && field instanceof HTMLTextAreaElement) schedulePreview(form, field.value);
  }
  let previewTimer = 0;
  function schedulePreview(form, value) {
    const slot = form.querySelector("[data-md-preview]");
    const url = form.getAttribute("data-preview");
    if (!slot || !url) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const data = new FormData();
      data.set("body", value);
      fetch(url, { method: "POST", body: data, headers: { accept: "application/json" } })
        .then((res) => res.json())
        .then((payload) => { if (payload && typeof payload.html === "string") slot.innerHTML = payload.html; })
        .catch(() => {});
    }, 180);
  }
  document.addEventListener("input", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement)) return;
    const form = field.closest("[data-inline-kind='markdown']");
    if (form) schedulePreview(form, field.value);
  });

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* private mode */ }
  }
  function laneMap() {
    try {
      const parsed = JSON.parse(storageGet(LANE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  function saveLanes(map) {
    storageSet(LANE_KEY, JSON.stringify(map));
  }

  function applyLanes() {
    applyingLanes = true;
    const saved = laneMap();
    document.querySelectorAll("details.lane").forEach((node) => {
      const code = node.getAttribute("data-lane") || "";
      if (Object.prototype.hasOwnProperty.call(saved, code)) node.open = !!saved[code];
    });
    applyingLanes = false;
  }

  function rememberLane(node) {
    if (applyingLanes) return;
    const code = node.getAttribute("data-lane");
    if (!code) return;
    const map = laneMap();
    map[code] = node.open;
    saveLanes(map);
  }

  let applyingGroups = false;
  function groupMap() {
    try {
      const parsed = JSON.parse(storageGet(GROUP_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  function saveGroups(map) {
    storageSet(GROUP_KEY, JSON.stringify(map));
  }
  function applyGroups() {
    applyingGroups = true;
    const map = groupMap();
    document.querySelectorAll("details.group[data-group]").forEach((el) => {
      const id = el.getAttribute("data-group");
      if (id && map[id]) el.open = false;
    });
    document.querySelectorAll("tbody.fg[data-group]").forEach((el) => {
      const id = el.getAttribute("data-group");
      const collapsed = !!(id && map[id]);
      el.classList.toggle("is-collapsed", collapsed);
      const btn = el.querySelector("[data-group-toggle]");
      if (btn) btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
    applyingGroups = false;
  }
  function rememberGroup(node) {
    if (applyingGroups) return;
    const id = node.getAttribute("data-group");
    if (!id) return;
    const map = groupMap();
    const collapsed = node.classList.contains("fg") ? node.classList.contains("is-collapsed") : !node.open;
    if (collapsed) map[id] = 1;
    else delete map[id];
    saveGroups(map);
  }
  function setGroups(open) {
    const map = groupMap();
    applyingGroups = true;
    document.querySelectorAll("details.group[data-group]").forEach((el) => {
      el.open = open;
      const id = el.getAttribute("data-group");
      if (!id) return;
      if (open) delete map[id];
      else map[id] = 1;
    });
    document.querySelectorAll("tbody.fg[data-group]").forEach((el) => {
      el.classList.toggle("is-collapsed", !open);
      const btn = el.querySelector("[data-group-toggle]");
      if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
      const id = el.getAttribute("data-group");
      if (!id) return;
      if (open) delete map[id];
      else map[id] = 1;
    });
    applyingGroups = false;
    saveGroups(map);
  }

  if (page === "board") {
    const params = new URLSearchParams(location.search);
    const view = params.get("view");
    let replace = false;
    if (view === "table" || view === "board") storageSet(VIEW_KEY, view);
    else if (storageGet(VIEW_KEY) === "table") {
      params.set("view", "table");
      replace = true;
    }
    if (params.has("project")) {
      storageSet(PROJECT_KEY, params.get("project") || "");
    } else {
      const saved = storageGet(PROJECT_KEY);
      if (saved) {
        params.set("project", saved);
        replace = true;
      }
    }
    if (replace) {
      const next = params.toString();
      location.replace(next ? location.pathname + "?" + next : location.pathname);
      return;
    }
    applyLanes();
    applyGroups();
  }

  function projectLinks() {
    return Array.from(document.querySelectorAll(".proj-nav a.proj"));
  }

  function switcherOptions() {
    return Array.from(document.querySelectorAll("#switcher-list a"));
  }

  function markSwitcher() {
    const items = switcherOptions();
    if (switcherIndex >= items.length) switcherIndex = 0;
    items.forEach((link, index) => {
      const on = index === switcherIndex;
      link.classList.toggle("is-active", on);
      if (on) link.setAttribute("aria-selected", "true");
      else link.removeAttribute("aria-selected");
    });
    const current = items[switcherIndex];
    if (current && current.scrollIntoView) current.scrollIntoView({ block: "nearest" });
  }

  function buildSwitcher(filter) {
    const list = document.getElementById("switcher-list");
    if (!list) return;
    const query = (filter || "").trim().toLowerCase();
    list.replaceChildren();
    switcherIndex = 0;
    for (const source of projectLinks()) {
      const text = (source.textContent || "").toLowerCase();
      if (query && text.indexOf(query) === -1) continue;
      const item = document.createElement("li");
      const link = source.cloneNode(true);
      link.classList.remove("is-current");
      link.removeAttribute("aria-current");
      item.appendChild(link);
      list.appendChild(item);
    }
    markSwitcher();
  }

  function htmlElement(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function regroupCell(cell) {
    const cards = Array.from(cell.querySelectorAll("a.card"));
    const remembered = groupMap();
    const openNow = {};
    cell.querySelectorAll("details.group").forEach((node) => {
      openNow[node.getAttribute("data-group") || ""] = node.open;
    });
    const buckets = new Map();
    cards.forEach((card) => {
      const code = card.getAttribute("data-feature") || "";
      if (!buckets.has(code)) buckets.set(code, []);
      buckets.get(code).push(card);
    });
    cards.forEach((card) => card.remove());
    cell.querySelectorAll("details.group").forEach((node) => node.remove());
    const seen = new Set();
    const status = cell.getAttribute("data-status") || "";
    cards.forEach((card) => {
      const code = card.getAttribute("data-feature") || "";
      const list = buckets.get(code) || [card];
      if (list.length < 2) {
        cell.appendChild(card);
        return;
      }
      if (seen.has(code)) return;
      seen.add(code);
      const id = "board:" + status + ":" + code;
      const details = document.createElement("details");
      details.className = "group";
      details.setAttribute("data-group", id);
      details.setAttribute("data-feature", code);
      const tint = list[0].getAttribute("data-tint") || "";
      if (tint) details.setAttribute("style", tint);
      const summary = document.createElement("summary");
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.setAttribute("aria-hidden", "true");
      const codeEl = document.createElement("span");
      codeEl.className = "code";
      codeEl.textContent = code;
      const titleEl = document.createElement("span");
      titleEl.className = "gtitle";
      titleEl.textContent = list[0].getAttribute("data-feature-title") || code;
      const countEl = document.createElement("span");
      countEl.className = "gcount";
      countEl.textContent = String(list.length);
      summary.append(chev, codeEl, titleEl, countEl);
      details.appendChild(summary);
      list.forEach((item) => details.appendChild(item));
      const collapsed = remembered[id] || openNow[id] === false;
      details.open = !collapsed;
      cell.appendChild(details);
    });
  }

  function syncCell(cell, cards) {
    const scroll = cell.scrollTop;
    const existing = new Map();
    cell.querySelectorAll("a.card").forEach((node) => {
      const code = node.dataset.code || "";
      const prev = existing.get(code);
      if (prev) prev.remove();
      existing.set(code, node);
    });
    const seen = new Set();
    for (const card of cards) {
      seen.add(card.code);
      let node = existing.get(card.code);
      if (!node || node.dataset.rev !== String(card.rev)) {
        const fresh = htmlElement(card.html);
        if (node && fresh) node.replaceWith(fresh);
        else if (fresh) cell.appendChild(fresh);
        node = fresh || node;
      }
      if (node) cell.appendChild(node);
    }
    existing.forEach((node, code) => {
      if (!seen.has(code)) node.remove();
    });
    regroupCell(cell);
    cell.scrollTop = scroll;
  }

  function applyBoard(data) {
    const groups = new Map();
    for (const card of data.cards || []) {
      const key = card.project_code + "\\n" + card.status;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    document.querySelectorAll(".cell[data-project]").forEach((cell) => {
      const key = (cell.getAttribute("data-project") || "") + "\\n" + (cell.getAttribute("data-status") || "");
      syncCell(cell, groups.get(key) || []);
    });
    document.querySelectorAll("[data-count-for]").forEach((el) => {
      const lane = el.getAttribute("data-count-for") || "";
      const status = el.getAttribute("data-status") || "";
      const cell = document.querySelector(".cell[data-project='" + CSS.escape(lane) + "'][data-status='" + CSS.escape(status) + "']");
      el.textContent = String(cell ? cell.querySelectorAll("a.card").length : 0);
    });
    document.querySelectorAll(".colh[data-status]").forEach((col) => {
      const status = col.getAttribute("data-status") || "";
      let count = 0;
      document.querySelectorAll(".cell[data-status='" + CSS.escape(status) + "']").forEach((cell) => {
        if (cell.closest(".cancelled")) return;
        count += cell.querySelectorAll("a.card").length;
      });
      const slot = col.querySelector("[data-col-count]");
      if (slot) slot.textContent = String(count);
    });
    document.querySelectorAll("a[href^='/done']").forEach((link) => {
      if ((link.textContent || "").trim().indexOf("See all") === 0 && typeof data.doneTotal === "number") {
        link.textContent = "See all (" + data.doneTotal + ")";
      }
    });
    const badge = document.querySelector("[data-alert-total]");
    if (badge && typeof data.alertTotal === "number") {
      badge.textContent = String(data.alertTotal);
      badge.classList.toggle("is-on", data.alertTotal > 0);
    }
    let openSum = 0;
    let alertSum = 0;
    for (const project of data.projects || []) {
      openSum += Number(project.open) || 0;
      alertSum += Number(project.alerts) || 0;
      const link = document.querySelector("[data-nav-project='" + CSS.escape(project.code) + "']");
      if (!link) continue;
      const open = link.querySelector("[data-open]");
      if (open) open.textContent = String(project.open);
      const alert = link.querySelector("[data-alerts]");
      if (alert) {
        alert.textContent = String(project.alerts);
        alert.classList.toggle("is-on", project.alerts > 0);
      }
    }
    const all = document.querySelector("[data-nav-project='*']");
    if (all) {
      const open = all.querySelector("[data-open]");
      if (open) open.textContent = String(openSum);
      const alert = all.querySelector("[data-alerts]");
      if (alert) {
        alert.textContent = String(alertSum);
        alert.classList.toggle("is-on", alertSum > 0);
      }
    }
    const stamp = document.querySelector("[data-poll-stamp]");
    if (stamp) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      stamp.textContent = "Updated " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    }
  }

  let polling = false;
  async function poll() {
    if (polling || document.hidden || page !== "board" || !document.getElementById("board")) return;
    polling = true;
    try {
      const search = body.dataset.boardSearch || "";
      const res = await fetch("/api/board" + (search ? "?" + search : ""), { headers: { accept: "application/json" } });
      if (!res.ok) return;
      applyBoard(await res.json());
    } catch (err) {
      /* keep the board that is already on screen */
    } finally {
      polling = false;
    }
  }

  async function openDrawer(href, push) {
    const raw = new URL(href, location.origin);
    const path = raw.pathname;
    let code = path.split("/").pop() || "";
    try { code = decodeURIComponent(code); } catch (err) { /* keep the raw segment */ }
    const dlg = document.getElementById("drawer");
    const slot = document.getElementById("drawer-body");
    const full = document.getElementById("drawer-full");
    const title = document.getElementById("drawer-title");
    if (!(dlg instanceof HTMLDialogElement) || !slot) return;
    const preferred = knownTab(raw.searchParams.get("tab") || "");
    const tab = preferred || rememberedTab();
    const shown = path + "?tab=" + encodeURIComponent(tab);
    if (full instanceof HTMLAnchorElement) full.href = shown;
    if (title) title.textContent = code;
    slot.textContent = "Loading…";
    if (!dlg.open) dlg.showModal();
    if (push) history.pushState({ hub: 1, drawer: code }, "", shown);
    try {
      const res = await fetch(path + "?fragment=1&tab=" + encodeURIComponent(tab), { headers: { accept: "text/html" } });
      if (!res.ok) {
        slot.textContent = "This task could not be loaded.";
        return;
      }
      slot.innerHTML = await res.text();
      const root = slot.querySelector(".task");
      if (root) applyTaskTab(root, false);
      requestAnimationFrame(() => measureClamps(slot));
      const focus = slot.querySelector("[role='tab'][aria-selected='true']");
      if (focus instanceof HTMLElement) focus.focus();
    } catch (err) {
      slot.textContent = "This task could not be loaded.";
    }
  }

  document.addEventListener("toggle", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLDetailsElement)) return;
    if (node.classList.contains("lane")) rememberLane(node);
    else if (node.classList.contains("group")) rememberGroup(node);
  }, true);

  let lbIndex = 0;
  let lbMode = "single";
  let lbPos = 50;
  let lbLeft = "";
  let lbRight = "";
  let lbSrc = "";
  let lbVersion = "";
  let splitDrag = null;

  function htmlEsc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function measureClamps(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-clamp]").forEach((box) => {
      const btn = box.parentElement && box.parentElement.querySelector("[data-clamp-toggle]");
      if (!(btn instanceof HTMLButtonElement) || box.classList.contains("is-open")) return;
      btn.hidden = box.scrollHeight <= box.clientHeight + 1;
    });
  }
  function galleryOf(root) {
    return Array.from((root || document).querySelectorAll("[data-lb]"));
  }
  function versionsOf(el) {
    const raw = el.getAttribute("data-versions");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  function versionSrc(versions, version) {
    const found = versions.find((item) => String(item.version) === String(version));
    return found ? found.src : "";
  }
  function layoutSplit(stage) {
    if (!stage) return;
    const clip = stage.querySelector(".split-clip");
    const img = clip && clip.querySelector("img");
    const bar = stage.querySelector("[data-split-bar]");
    if (clip) clip.style.width = lbPos + "%";
    if (img) {
      img.style.width = stage.clientWidth + "px";
      img.style.height = stage.clientHeight + "px";
    }
    if (bar) bar.style.left = lbPos + "%";
    stage.setAttribute("aria-valuenow", String(Math.round(lbPos)));
  }
  function renderLightbox() {
    const dlg = document.getElementById("lightbox");
    const stage = document.getElementById("lb-stage");
    if (!dlg || !stage) return;
    const root = dlg.closest(".task") || document;
    const items = galleryOf(root);
    if (lbIndex >= items.length) lbIndex = Math.max(0, items.length - 1);
    const el = items[lbIndex];
    if (!el) return;
    const versions = versionsOf(el);
    const name = el.getAttribute("data-name") || "Image";
    const title = document.getElementById("lb-title");
    const ver = document.getElementById("lb-ver");
    const download = document.getElementById("lb-download");
    const tools = dlg.querySelector(".lb-tools");
    const splitBtn = dlg.querySelector("[data-lb-mode='split']");
    const sideBtn = dlg.querySelector("[data-lb-mode='side']");
    const canCompare = versions.length > 1;
    if (tools) tools.hidden = !canCompare;
    if (splitBtn instanceof HTMLButtonElement) splitBtn.hidden = !canCompare;
    if (sideBtn instanceof HTMLButtonElement) sideBtn.hidden = !canCompare;
    if (canCompare && !lbLeft) lbLeft = String(versions[versions.length - 1].version);
    if (canCompare && !lbRight) lbRight = String(versions[0].version);
    const leftSel = document.getElementById("lb-left");
    const rightSel = document.getElementById("lb-right");
    if (canCompare && leftSel instanceof HTMLSelectElement && rightSel instanceof HTMLSelectElement && leftSel.options.length !== versions.length) {
      const opts = versions.map((item) => '<option value="' + htmlEsc(item.version) + '">v' + htmlEsc(item.version) + "</option>").join("");
      leftSel.innerHTML = opts;
      rightSel.innerHTML = opts;
    }
    if (leftSel instanceof HTMLSelectElement && lbLeft) leftSel.value = String(lbLeft);
    if (rightSel instanceof HTMLSelectElement && lbRight) rightSel.value = String(lbRight);
    const singleSrc = lbSrc || el.getAttribute("data-src") || "";
    const singleVer = lbVersion || el.getAttribute("data-version") || "";
    if (title) title.textContent = name;
    if (lbMode !== "single" && canCompare) {
      const leftSrc = versionSrc(versions, lbLeft);
      const rightSrc = versionSrc(versions, lbRight);
      if (ver) ver.textContent = "v" + lbLeft + " · v" + lbRight;
      if (download instanceof HTMLAnchorElement) {
        download.href = rightSrc || leftSrc;
        download.textContent = "Download v" + lbRight;
      }
      if (lbMode === "side") {
        stage.innerHTML = '<div class="lb-side"><figure><img alt="" src="' + htmlEsc(leftSrc) + '"><figcaption>v' + htmlEsc(lbLeft) + '</figcaption></figure><figure><img alt="" src="' + htmlEsc(rightSrc) + '"><figcaption>v' + htmlEsc(lbRight) + "</figcaption></figure></div>";
      } else {
        stage.innerHTML = '<div class="split" data-split tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="100" aria-label="Compare versions"><img alt="" src="' + htmlEsc(rightSrc) + '"><div class="split-clip"><img alt="" src="' + htmlEsc(leftSrc) + '"></div><button type="button" class="split-bar" data-split-bar aria-hidden="true"></button><span class="split-label left">v' + htmlEsc(lbLeft) + '</span><span class="split-label right">v' + htmlEsc(lbRight) + "</span></div>";
        const split = stage.querySelector("[data-split]");
        layoutSplit(split);
        if (split instanceof HTMLElement) split.focus();
      }
    } else {
      if (ver) ver.textContent = singleVer ? "v" + singleVer : "";
      if (download instanceof HTMLAnchorElement) {
        download.href = singleSrc;
        download.textContent = "Download";
      }
      stage.innerHTML = '<img class="lb-single" alt="' + htmlEsc(name) + '" src="' + htmlEsc(singleSrc) + '">';
    }
    const prev = dlg.querySelector("[data-lb-prev]");
    const next = dlg.querySelector("[data-lb-next]");
    if (prev instanceof HTMLButtonElement) prev.disabled = lbIndex <= 0;
    if (next instanceof HTMLButtonElement) next.disabled = lbIndex >= items.length - 1;
  }
  function openLightbox(el, opts) {
    const root = el.closest(".task") || document;
    const items = galleryOf(root);
    const idx = items.indexOf(el);
    lbIndex = idx >= 0 ? idx : 0;
    lbMode = (opts && opts.mode) || "single";
    lbPos = 50;
    lbLeft = (opts && opts.left) || "";
    lbRight = (opts && opts.right) || "";
    lbSrc = (opts && opts.src) || "";
    lbVersion = (opts && opts.version) || "";
    const dlg = root.querySelector("#lightbox") || document.getElementById("lightbox");
    if (dlg instanceof HTMLDialogElement && !dlg.open) dlg.showModal();
    renderLightbox();
    requestAnimationFrame(() => layoutSplit(document.querySelector("#lightbox [data-split]")));
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLDialogElement && target.open) {
      target.close();
      return;
    }
    if (!(target instanceof Element)) return;
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    const projectLink = target.closest("[data-project-link]");
    if (projectLink) storageSet(PROJECT_KEY, projectLink.getAttribute("data-project-link") || "");
    if (modified) return;

    const lanesBtn = target.closest("[data-lanes]");
    if (lanesBtn) {
      const open = lanesBtn.getAttribute("data-lanes") === "open";
      const map = laneMap();
      document.querySelectorAll("details.lane").forEach((node) => {
        node.open = open;
        const code = node.getAttribute("data-lane");
        if (code) map[code] = open;
      });
      saveLanes(map);
      return;
    }

    const groupsBtn = target.closest("[data-groups]");
    if (groupsBtn) {
      setGroups(groupsBtn.getAttribute("data-groups") === "open");
      return;
    }

    const groupToggle = target.closest("[data-group-toggle]");
    if (groupToggle) {
      const body = groupToggle.closest("tbody.fg");
      if (body) {
        const collapsed = !body.classList.contains("is-collapsed");
        body.classList.toggle("is-collapsed", collapsed);
        groupToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
        rememberGroup(body);
      }
      return;
    }

    const row = target.closest("tr.task-row");
    if (row) {
      const interactive = target.closest("a,button,input,select,textarea,label");
      const rowLink = interactive instanceof HTMLAnchorElement && interactive.classList.contains("rowmain");
      if (interactive && !rowLink) return;
      const link = row.querySelector("a.rowmain");
      if (link instanceof HTMLAnchorElement) {
        event.preventDefault();
        openDrawer(link.getAttribute("href") || link.href, true);
      }
      return;
    }

    const opener = target.closest("[data-dialog-open]");
    if (opener) {
      const id = opener.getAttribute("data-dialog-open");
      const dlg = id ? document.getElementById(id) : null;
      if (dlg instanceof HTMLDialogElement) {
        event.preventDefault();
        if (dlg.id === "switcher") {
          const input = document.getElementById("switcher-input");
          if (input instanceof HTMLInputElement) input.value = "";
          buildSwitcher("");
        }
        if (dlg.id === "add-file") {
          const group = opener.getAttribute("data-file-group") || "requirement";
          const preset = opener.getAttribute("data-file-name") || "";
          const heading = dlg.querySelector("h2");
          if (heading) heading.textContent = preset ? "New version" : "Add file";
          const groupInput = dlg.querySelector("[name=group]");
          if (groupInput) groupInput.value = group;
          const nameInput = dlg.querySelector("[name=name]");
          if (nameInput instanceof HTMLInputElement) nameInput.value = preset;
          const noteInput = dlg.querySelector("[name=note]");
          if (noteInput instanceof HTMLInputElement) noteInput.value = "";
          const fileInput = dlg.querySelector("[name=file]");
          if (fileInput instanceof HTMLInputElement) fileInput.value = "";
          const label = dlg.querySelector("[data-file-label]");
          if (label) label.textContent = preset ? "Drop a new version of " + preset + "." : "Drop a file here, or choose one.";
        }
        dlg.showModal();
        const focus = dlg.querySelector("input, button");
        if (focus instanceof HTMLElement) focus.focus();
      }
      return;
    }

    const closer = target.closest("[data-close-dialog]");
    if (closer) {
      const dlg = closer.closest("dialog");
      if (dlg instanceof HTMLDialogElement) dlg.close();
      return;
    }

    const pen = target.closest("[data-inline-open]");
    if (pen) {
      const form = editForm(pen);
      if (form) openEdit(form);
      return;
    }
    const clampBtn = target.closest("[data-clamp-toggle]");
    if (clampBtn) {
      const box = clampBtn.parentElement && clampBtn.parentElement.querySelector("[data-clamp]");
      if (box) {
        const open = box.classList.toggle("is-open");
        clampBtn.textContent = open ? "Show less" : "Show more";
      }
      return;
    }
    const compareToggle = target.closest("[data-compare-toggle]");
    if (compareToggle) {
      const form = compareToggle.closest("form");
      const field = form && form.querySelector(".diff-field");
      const open = compareToggle.getAttribute("aria-expanded") === "true";
      if (open && form instanceof HTMLFormElement) {
        const diff = form.querySelector("[name=diff]");
        if (diff) diff.value = "";
        compareToggle.setAttribute("aria-expanded", "false");
        if (field) field.hidden = true;
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      } else if (field) {
        field.hidden = false;
        compareToggle.setAttribute("aria-expanded", "true");
        const select = field.querySelector("select");
        if (select instanceof HTMLElement) select.focus();
      }
      return;
    }
    const lbOpen = target.closest("[data-lb]");
    if (lbOpen) {
      event.preventDefault();
      openLightbox(lbOpen, null);
      return;
    }
    const lbName = target.closest("[data-lb-open]");
    if (lbName) {
      const id = lbName.getAttribute("data-lb-open");
      const el = id && document.querySelector('[data-lb][data-id="' + id + '"]');
      if (el) openLightbox(el, null);
      return;
    }
    const jump = target.closest("[data-lb-jump]");
    if (jump) {
      const id = jump.getAttribute("data-lb-jump");
      const el = id && document.querySelector('[data-lb][data-id="' + id + '"]');
      if (el) openLightbox(el, { mode: "single", src: jump.getAttribute("data-src") || "", version: jump.getAttribute("data-version") || "" });
      const pop = jump.closest("[popover]");
      if (pop && pop.hidePopover) pop.hidePopover();
      return;
    }
    const cmp = target.closest("[data-open-compare]");
    if (cmp) {
      const pop = cmp.closest("[popover]");
      const id = cmp.getAttribute("data-id");
      const el = id && document.querySelector('[data-lb][data-id="' + id + '"]');
      const left = pop && pop.querySelector("[data-cmp-left]");
      const right = pop && pop.querySelector("[data-cmp-right]");
      if (el) openLightbox(el, { mode: "split", left: left ? left.value : "", right: right ? right.value : "" });
      if (pop && pop.hidePopover) pop.hidePopover();
      return;
    }
    const modeBtn = target.closest("[data-lb-mode]");
    if (modeBtn) {
      lbMode = modeBtn.getAttribute("data-lb-mode") || "split";
      lbSrc = "";
      lbVersion = "";
      renderLightbox();
      return;
    }
    if (target.closest("[data-lb-prev]")) {
      lbIndex = Math.max(0, lbIndex - 1);
      lbMode = "single";
      lbSrc = "";
      lbVersion = "";
      lbLeft = "";
      lbRight = "";
      renderLightbox();
      return;
    }
    if (target.closest("[data-lb-next]")) {
      lbIndex += 1;
      lbMode = "single";
      lbSrc = "";
      lbVersion = "";
      lbLeft = "";
      lbRight = "";
      renderLightbox();
      return;
    }
    const cancelEdit = target.closest("[data-inline-cancel]");
    if (cancelEdit) {
      const form = cancelEdit.closest("[data-inline-edit]");
      if (form) closeEdit(form, true);
      return;
    }
    const tabLink = target.closest("[role='tab']");
    if (tabLink && !modified) {
      const root = tabLink.closest(".task");
      if (root) {
        event.preventDefault();
        const name = knownTab(tabLink.getAttribute("data-tab") || "") || "overview";
        const url = new URL(tabLink.href, location.origin);
        history.replaceState(history.state, "", url.pathname + "?tab=" + encodeURIComponent(name));
        applyTaskTab(root, false);
        if (tabLink instanceof HTMLElement) tabLink.focus();
      }
      return;
    }

    const card = target.closest("a.card");
    if (card instanceof HTMLAnchorElement && card.origin === location.origin) {
      event.preventDefault();
      openDrawer(card.getAttribute("href") || card.href, true);
    }
  });

  document.addEventListener("keydown", (event) => {
    const editing = event.target instanceof Element ? event.target.closest(".inline-edit.is-editing") : null;
    if (editing && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEdit(editing, true);
      return;
    }
    if (editing && event.key === "Enter" && event.target instanceof HTMLSelectElement) {
      event.preventDefault();
      const form = event.target.form;
      if (form) form.requestSubmit();
      return;
    }
    if (event.target instanceof HTMLTextAreaElement && event.key === "Enter" && (event.metaKey || event.ctrlKey) && (event.target.closest(".feedback-dock") || event.target.closest("[data-inline-kind='markdown']"))) {
      event.preventDefault();
      const form = event.target.form;
      if (form) form.requestSubmit();
      return;
    }
    const tabEl = event.target instanceof Element ? event.target.closest("[role='tab']") : null;
    if (tabEl && (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) {
      const list = tabEl.closest("[role='tablist']");
      if (list) {
        const tabs = Array.from(list.querySelectorAll("[role='tab']"));
        let index = tabs.indexOf(tabEl);
        if (event.key === "ArrowRight" || event.key === "ArrowDown") index = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") index = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") index = 0;
        else index = tabs.length - 1;
        event.preventDefault();
        const next = tabs[index];
        if (next instanceof HTMLElement) next.click();
        return;
      }
    }
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      const dlg = document.getElementById("switcher");
      if (!(dlg instanceof HTMLDialogElement)) return;
      event.preventDefault();
      const input = document.getElementById("switcher-input");
      if (input instanceof HTMLInputElement) input.value = "";
      buildSwitcher("");
      if (!dlg.open) dlg.showModal();
      if (input instanceof HTMLElement) input.focus();
      return;
    }
    const dlg = document.getElementById("switcher");
    if (!(dlg instanceof HTMLDialogElement) || !dlg.open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = switcherOptions();
      if (!items.length) return;
      event.preventDefault();
      if (event.key === "ArrowDown") switcherIndex = (switcherIndex + 1) % items.length;
      else switcherIndex = (switcherIndex - 1 + items.length) % items.length;
      markSwitcher();
    } else if (event.key === "Enter") {
      const current = switcherOptions()[switcherIndex];
      if (current) {
        event.preventDefault();
        current.click();
      }
    }
  });

  const switcherInput = document.getElementById("switcher-input");
  if (switcherInput) {
    switcherInput.addEventListener("input", (event) => {
      const value = event.target instanceof HTMLInputElement ? event.target.value : "";
      buildSwitcher(value);
    });
  }

  document.addEventListener("cancel", (event) => {
    const dlg = event.target;
    if (!(dlg instanceof HTMLDialogElement)) return;
    const editing = dlg.querySelector(".inline-edit.is-editing");
    if (!editing) return;
    event.preventDefault();
    closeEdit(editing, true);
  }, true);

  const drawer = document.getElementById("drawer");
  if (drawer instanceof HTMLDialogElement) {
    drawer.addEventListener("close", () => {
      if (drawerSilent) return;
      if (history.state && history.state.drawer) history.back();
    });
  }
  window.addEventListener("popstate", () => {
    const dlg = document.getElementById("drawer");
    if (!(dlg instanceof HTMLDialogElement)) return;
    const code = history.state && history.state.drawer;
    if (!code && dlg.open) {
      drawerSilent = true;
      dlg.close();
      drawerSilent = false;
    } else if (code && !dlg.open) {
      openDrawer(location.pathname + location.search, false);
    }
  });
  if (page === "task") applyTaskTab(document.querySelector("main .task"), true);
  requestAnimationFrame(() => measureClamps(document));
  if (!history.state) history.replaceState({ hub: 1 }, "");

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute("data-inline-edit")) {
      event.preventDefault();
      const field = form.querySelector("input, select, textarea");
      const msg = form.querySelector(".ie-msg");
      const markdown = form.getAttribute("data-inline-kind") === "markdown";
      form.classList.add("is-saving");
      if (msg) msg.textContent = "Saving…";
      fetch(form.action, { method: "POST", body: new FormData(form), headers: { accept: "application/json" } })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Could not save");
          if (markdown) {
            const next = new URL(location.href);
            next.searchParams.set("tab", "overview");
            next.searchParams.delete("rv");
            next.searchParams.delete("diff");
            next.searchParams.delete("fragment");
            location.assign(next.pathname + "?" + next.searchParams.toString());
            return;
          }
          const value = field && "value" in field ? String(field.value) : "";
          if (field) field.setAttribute("data-original", value);
          paintValue(form, value.trim());
          closeEdit(form, false);
          if (page === "board") poll();
        })
        .catch((err) => {
          form.classList.remove("is-saving");
          if (msg) msg.textContent = err instanceof Error ? err.message : "Could not save";
        });
      return;
    }
    if (form.getAttribute("action") !== "/logout") return;
    if (form.dataset.confirmed === "1") return;
    const dlg = document.getElementById("confirm");
    if (!(dlg instanceof HTMLDialogElement)) return;
    event.preventDefault();
    dlg.showModal();
    dlg.addEventListener("close", () => {
      if (dlg.returnValue === "confirm") {
        form.dataset.confirmed = "1";
        form.submit();
      }
    }, { once: true });
  });

  document.addEventListener("change", (event) => {
    const node = event.target;
    if (node instanceof HTMLInputElement && node.type === "file" && node.files && node.files[0]) {
      const dlg = node.closest("dialog");
      const name = dlg && dlg.querySelector("[name=name]");
      if (name instanceof HTMLInputElement && !name.value) name.value = node.files[0].name;
    }
    if (!(node instanceof HTMLSelectElement)) return;
    if (node.id === "lb-left" || node.id === "lb-right") {
      const left = document.getElementById("lb-left");
      const right = document.getElementById("lb-right");
      if (left instanceof HTMLSelectElement) lbLeft = left.value;
      if (right instanceof HTMLSelectElement) lbRight = right.value;
      if (lbMode === "single") lbMode = "split";
      lbSrc = "";
      lbVersion = "";
      renderLightbox();
      return;
    }
    const pick = node.closest(".request-pick");
    if (pick instanceof HTMLFormElement) {
      if (pick.requestSubmit) pick.requestSubmit();
      else pick.submit();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    const bar = event.target instanceof Element ? event.target.closest("[data-split-bar]") : null;
    const stage = bar && bar.closest("[data-split]");
    if (!stage) return;
    splitDrag = stage;
    if (stage.setPointerCapture) stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener("pointermove", (event) => {
    if (!splitDrag) return;
    const rect = splitDrag.getBoundingClientRect();
    if (!rect.width) return;
    lbPos = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    layoutSplit(splitDrag);
  });
  document.addEventListener("pointerup", () => { splitDrag = null; });
  document.addEventListener("pointercancel", () => { splitDrag = null; });
  document.addEventListener("keydown", (event) => {
    const stage = document.querySelector("[data-split]");
    if (!stage || (document.activeElement !== stage && !stage.contains(document.activeElement))) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (event.key === "Home") lbPos = 0;
    else if (event.key === "End") lbPos = 100;
    else lbPos = Math.min(100, Math.max(0, lbPos + (event.key === "ArrowRight" ? 4 : -4)));
    layoutSplit(stage);
  });
  document.addEventListener("dragover", (event) => {
    const zone = event.target instanceof Element ? event.target.closest("[data-dropzone]") : null;
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("is-over");
  });
  document.addEventListener("dragleave", (event) => {
    const zone = event.target instanceof Element ? event.target.closest("[data-dropzone]") : null;
    if (zone) zone.classList.remove("is-over");
  });
  document.addEventListener("drop", (event) => {
    const zone = event.target instanceof Element ? event.target.closest("[data-dropzone]") : null;
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("is-over");
    const input = zone.querySelector("input[type=file]");
    const files = event.dataTransfer && event.dataTransfer.files;
    if (input instanceof HTMLInputElement && files && files.length) {
      input.files = files;
      const dlg = zone.closest("dialog");
      const name = dlg && dlg.querySelector("[name=name]");
      if (name instanceof HTMLInputElement && !name.value) name.value = files[0].name;
      const label = zone.querySelector("[data-file-label]");
      if (label) label.textContent = files[0].name;
    }
  });

  if (page === "board") {
    setInterval(poll, 60000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
    });
  }
})();
`;
