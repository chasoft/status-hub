// Static dashboard behaviour. Served as /assets/dashboard.js (no inline handlers).
export const DASHBOARD_JS = `
(() => {
  const PROJECT_KEY = "status-hub:project";
  const LANE_KEY = "status-hub:lanes";
  const body = document.body;
  if (!body || !body.classList.contains("app")) return;

  const page = body.dataset.page || "";
  let applyingLanes = false;
  let drawerSilent = false;
  let switcherIndex = 0;

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

  if (page === "board") {
    const params = new URLSearchParams(location.search);
    if (params.has("project")) {
      storageSet(PROJECT_KEY, params.get("project") || "");
    } else {
      const saved = storageGet(PROJECT_KEY);
      if (saved) {
        params.set("project", saved);
        const next = params.toString();
        location.replace(next ? location.pathname + "?" + next : location.pathname);
        return;
      }
    }
    applyLanes();
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

  function syncCell(cell, cards) {
    const scroll = cell.scrollTop;
    const existing = new Map();
    cell.querySelectorAll("a.card").forEach((node) => existing.set(node.dataset.code || "", node));
    const seen = new Set();
    for (const card of cards) {
      seen.add(card.code);
      let node = existing.get(card.code);
      if (!node || node.dataset.rev !== card.rev) node = htmlElement(card.html);
      if (node) cell.appendChild(node);
    }
    existing.forEach((node, code) => {
      if (!seen.has(code)) node.remove();
    });
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
    if (full instanceof HTMLAnchorElement) full.href = path;
    if (title) title.textContent = code;
    slot.textContent = "Loading…";
    if (!dlg.open) dlg.showModal();
    if (push) history.pushState({ hub: 1, drawer: code }, "", path);
    try {
      const res = await fetch(path + "?fragment=1", { headers: { accept: "text/html" } });
      if (!res.ok) {
        slot.textContent = "This task could not be loaded.";
        return;
      }
      slot.innerHTML = await res.text();
      const focus = slot.querySelector("h2, a, button, input, textarea");
      if (focus instanceof HTMLElement) focus.focus();
    } catch (err) {
      slot.textContent = "This task could not be loaded.";
    }
  }

  document.addEventListener("toggle", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLDetailsElement) || !node.classList.contains("lane")) return;
    rememberLane(node);
  }, true);

  document.addEventListener("click", (event) => {
    const target = event.target;
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

    const card = target.closest("a.card");
    if (card instanceof HTMLAnchorElement && card.origin === location.origin) {
      event.preventDefault();
      openDrawer(card.getAttribute("href") || card.href, true);
    }
  });

  document.addEventListener("keydown", (event) => {
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
      openDrawer("/t/" + encodeURIComponent(code), false);
    }
  });
  if (!history.state) history.replaceState({ hub: 1 }, "");

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
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

  if (page === "board") {
    setInterval(poll, 60000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
    });
  }
})();
`;
