(function () {
  "use strict";

  const mapConfig = window.RESCUENET_MAP_CONFIG || {};
  const POLL_INTERVAL_MS = Number(mapConfig.pollIntervalMs) || 5000;
  const INCIDENT_POLL_INTERVAL_MS = 2000;
  const ui = window.RescueNetUI;
  const {h, display, numberDisplay, formatTime, formatShortTime, relativeTime, formatUptime, isCritical, badge, operationalBadge} = ui;
  const viewMeta = {
    dashboard: ["Dashboard", "Emergency response and mesh network overview"],
    reports: ["Emergency Reports", "Review and coordinate incident handling"],
    map: ["GPS Map", "Emergency report locations available to the command center"],
    nodes: ["Mesh Nodes", "Field-node report activity and logical topology"],
    system: ["System Status", "Local server, Gateway, and Raspberry Pi health"],
  };

  const state = {
    reports: null,
    mobileSos: null,
    nodes: null,
    stats: null,
    activity: null,
    health: null,
    system: null,
    mapSnapshot: null,
    mapFilter: "all",
    sortKey: "received_at",
    sortDirection: "desc",
    currentReportId: null,
    refreshing: false,
    mobileSosRefreshing: false,
    mapRefreshing: false,
    toastTimer: null,
    reportPage: 1,
    selectedIncidentKey: null,
    selectedNodeId: null,
    selectedMapPositionId: null,
    modalReturnFocus: null,
    feedFailures: {},
  };

  const byId = (id) => document.getElementById(id);
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  async function apiFetch(path, options = {}) {
    const response = await fetch(path, {
      headers: { Accept: "application/json", ...(options.headers || {}) },
      cache: "no-store",
      ...options,
    });
    let body = null;
    try {
      body = await response.json();
    } catch (_error) {
      body = null;
    }
    if (!response.ok) {
      throw new Error(body && body.error ? body.error : `Request failed (${response.status})`);
    }
    return body;
  }

  function showToast(message, isError = false) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = "toast"; }, 3200);
  }

  function setConnection(connected) {
    const container = byId("connection-state");
    const dot = container.querySelector(".state-dot");
    const title = container.querySelector("strong");
    dot.className = `state-dot ${connected ? "connected" : "disconnected"}`;
    title.textContent = connected ? "Local Server Connected" : "Local Server Unreachable";
    if (connected) {
      byId("last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
  }

  function renderRefreshWarning() {
    const labels = {reports: "Reports", mobile: "PWA SOS", map: "GPS map", nodes: "Node telemetry", stats: "Summary", activity: "Activity", health: "Service health", system: "System metrics"};
    const failed = Object.keys(state.feedFailures).filter(key => state.feedFailures[key]).map(key => labels[key]);
    const warning = byId("refresh-warning");
    warning.hidden = failed.length === 0;
    warning.textContent = failed.length ? `${failed.join(", ")} refresh unavailable. Last received data is retained where available; it may be out of date.` : "";
  }

  function switchView(name) {
    if (!viewMeta[name]) return;
    all("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === name));
    all(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    byId("page-title").textContent = viewMeta[name][0];
    byId("page-subtitle").textContent = viewMeta[name][1];
    document.title = `${viewMeta[name][0]} · RescueNet`;
    window.history.replaceState(null, "", `#${name}`);
    all(".nav-item").forEach(item => item.setAttribute("aria-current", item.dataset.view === name ? "page" : "false"));
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "map") {
      window.setTimeout(() => {
        const record = liveMaps.get("full-map");
        if (record) record.map.invalidateSize();
      }, 80);
    }
  }

  function openSidebar() {
    byId("mobile-menu").setAttribute("aria-expanded", "true");
    byId("sidebar").classList.add("open");
    byId("sidebar-overlay").classList.add("open");
  }

  function closeSidebar() {
    byId("mobile-menu").setAttribute("aria-expanded", "false");
    byId("sidebar").classList.remove("open");
    byId("sidebar-overlay").classList.remove("open");
  }

  const maps = ui.pages.map.create({state, mapConfig, switchView});
  const {liveMaps, renderMaps, renderMapFailure, fitMapMarkers, focusMapPosition} = maps;
  function renderStats() { ui.pages.dashboard.renderStats(state); }
  function renderNodes() { ui.pages.dashboard.renderNodes(state); ui.pages.nodes.render(state); }
  function renderGateway() { ui.pages.dashboard.renderGateway(state); }
  function renderReports() { ui.pages.reports.render(state); ui.pages.dashboard.renderSos(state); }
  function renderMobileSos() { ui.pages.reports.renderMobile(state); ui.pages.dashboard.renderSos(state); }
  function renderActivity() { ui.pages.dashboard.renderActivity(state); }
  function renderSystem() { ui.pages.system.render(state); }

  async function refreshIncidents() {
    if (state.mobileSosRefreshing) return;
    state.mobileSosRefreshing = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    try {
      const [reportsResult, eventsResult] = await Promise.allSettled([
        apiFetch("/api/reports?limit=1000", { signal: controller.signal }),
        apiFetch("/api/mobile/events?limit=100", { signal: controller.signal }),
      ]);
      let newSos = null;
      state.feedFailures.reports = !(reportsResult.status === "fulfilled" && Array.isArray(reportsResult.value));
      state.feedFailures.mobile = !(eventsResult.status === "fulfilled" && Array.isArray(eventsResult.value));
      if (reportsResult.status === "fulfilled" && Array.isArray(reportsResult.value)) {
        const reportsWereLoaded = Array.isArray(state.reports);
        const previousIds = new Set((state.reports || []).filter((report) => Number(report.sos) === 1).map((report) => String(report.id)));
        state.reports = reportsResult.value;
        renderReports();
        if (reportsWereLoaded) {
          newSos = reportsResult.value.find((report) => Number(report.sos) === 1 && !previousIds.has(String(report.id)));
          if (newSos) showToast(`SOS baru diterima server dari Field Node ${newSos.src_id}.`);
        }
      } else if (state.reports === null) {
        renderFailure(["reports-table", "recent-reports", "report-summary"], "Reports API unavailable.");
      }
      if (eventsResult.status === "fulfilled" && Array.isArray(eventsResult.value)) {
        const mobileSosWasLoaded = Array.isArray(state.mobileSos);
        const previousKeys = new Set((state.mobileSos || []).map((event) => String(event.request_key || "")));
        state.mobileSos = eventsResult.value.filter((event) => event && event.event_type === "SOS");
        renderMobileSos();
        if (mobileSosWasLoaded) {
          const newEvent = state.mobileSos.find((event) => !previousKeys.has(String(event.request_key || "")));
          if (newEvent && !newSos) showToast(`SOS PWA baru tersimpan di server dari Field Node ${newEvent.source_node}.`);
        }
      } else if (state.mobileSos === null) {
        ["reports-mobile-sos"].forEach((id) => {
          const target = byId(id);
          if (target) target.innerHTML = `<div class="error-state">PWA SOS status is temporarily unavailable.</div>`;
        });
      }
      if (state.reports === null && state.mobileSos === null) renderFailure(["dashboard-mobile-sos"], "SOS APIs unavailable.");
      else ui.pages.dashboard.renderSos(state);
      renderRefreshWarning();
    } finally {
      window.clearTimeout(timeout);
      state.mobileSosRefreshing = false;
    }
  }

  async function refreshMapSnapshot() {
    if (state.mapRefreshing) return;
    state.mapRefreshing = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    try {
      const snapshot = await apiFetch("/api/map/positions", { signal: controller.signal });
      if (!snapshot || !Array.isArray(snapshot.positions)) throw new Error("Invalid map response");
      state.mapSnapshot = snapshot;
      state.feedFailures.map = false;
      renderMaps();
    } catch (_error) {
      state.feedFailures.map = true;
      if (state.mapSnapshot === null) renderMapFailure("The local map API did not respond.");
    } finally {
      renderRefreshWarning();
      window.clearTimeout(timeout);
      state.mapRefreshing = false;
    }
  }

  function renderFailure(targetIds, message) {
    targetIds.forEach((id) => {
      const element = byId(id);
      if (element) element.innerHTML = `<div class="error-state">${h(message)}</div>`;
    });
  }

  async function refreshAll({ manual = false } = {}) {
    if (state.refreshing) return;
    // Reports, PWA SOS, and map have independent polling loops so a slow
    // system/chart endpoint cannot delay emergency visibility or GPS markers.
    void refreshIncidents();
    void refreshMapSnapshot();
    state.refreshing = true;
    const button = byId("refresh-button");
    button.classList.add("loading");
    button.disabled = true;

    const requests = [
      ["nodes", "/api/nodes"],
      ["stats", "/api/stats"],
      ["activity", "/api/activity?hours=6"],
      ["health", "/api/health"],
      ["system", "/api/system"],
    ];
    const results = await Promise.allSettled(requests.map(([, path]) => apiFetch(path)));
    let successes = 0;
    results.forEach((result, index) => {
      const key = requests[index][0];
      state.feedFailures[key] = result.status !== "fulfilled";
      if (result.status === "fulfilled") {
        state[key] = result.value;
        successes += 1;
      } else if (state[key] === null) {
        if (key === "nodes") renderFailure(["dashboard-nodes", "node-detail-grid", "topology-nodes", "node-roster", "node-summary"], "Node activity unavailable.");
        if (key === "activity") renderFailure(["dashboard-activity"], "Activity API unavailable.");
        if (key === "health") renderFailure(["gateway-summary", "service-grid"], "Service status unavailable.");
        if (key === "system") renderFailure(["metric-grid"], "System metrics unavailable.");
      }
    });

    setConnection(successes > 0);
    renderRefreshWarning();
    renderStats();
    renderNodes();
    renderGateway();
    renderActivity();
    renderSystem();
    if (manual) showToast(successes === requests.length ? "Command center data refreshed." : "Refresh completed with unavailable services.", successes === 0);

    state.refreshing = false;
    button.classList.remove("loading");
    button.disabled = false;
  }

  async function openReport(reportId) {
    const id = Number(reportId);
    if (!Number.isInteger(id) || id <= 0) return;
    state.currentReportId = id;
    state.modalReturnFocus = document.activeElement;
    const modal = byId("report-modal");
    modal.hidden = false;
    byId("modal-close").focus();
    document.body.style.overflow = "hidden";
    byId("modal-title").textContent = `Report #${id}`;
    let modalBody = modal.querySelector(".modal-body");
    if (!modalBody) {
      modalBody = document.createElement("div");
      modalBody.className = "modal-body";
      modal.querySelector(".modal-header").after(modalBody);
    }
    modalBody.innerHTML = `<div class="loading-state">Loading report details…</div>`;
    let footer = modal.querySelector(".modal-footer");
    if (footer) footer.remove();
    try {
      const report = await apiFetch(`/api/reports/${id}`);
      if (state.currentReportId !== id || modal.hidden) return;
      modalBody.innerHTML = `<dl class="detail-grid">
        <div><dt>Database ID</dt><dd>#${h(report.id)}</dd></div>
        <div><dt>Packet ID</dt><dd>${display(report.pkt_id)}</dd></div>
        <div><dt>Source Node</dt><dd>Node ${display(report.src_id)}</dd></div>
        <div><dt>Condition</dt><dd>${display(report.kondisi)}</dd></div>
        <div><dt>SOS</dt><dd>${Number(report.sos) === 1 ? badge("SOS", "danger") : "No"}</dd></div>
        <div><dt>Victim Count</dt><dd>${display(report.jumlah)}</dd></div>
        <div><dt>Hop / Max Hop</dt><dd>${display(report.hop)} / ${display(report.max_hop)}</dd></div>
        <div><dt>GPS Availability</dt><dd>${Number(report.has_gps) === 1 ? "Available" : "Unavailable"}</dd></div>
        <div><dt>Latitude</dt><dd>${numberDisplay(report.lat, 6)}</dd></div>
        <div><dt>Longitude</dt><dd>${numberDisplay(report.lon, 6)}</dd></div>
        <div><dt>Gateway RX RSSI</dt><dd>${display(report.rssi, " dBm")}</dd></div>
        <div><dt>Gateway RX SNR</dt><dd>${numberDisplay(report.snr, 1, " dB")}</dd></div>
        <div class="wide"><dt>Message</dt><dd class="detail-message">${h(report.pesan || "No message provided")}</dd></div>
        <div class="wide"><dt>Received Time</dt><dd>${h(formatTime(report.received_at))}</dd></div>
      </dl>`;
      footer = document.createElement("div");
      footer.className = "modal-footer";
      footer.innerHTML = `<label for="modal-status">Handling status</label><select id="modal-status"><option>BARU</option><option>DITANGANI</option><option>SELESAI</option></select><button class="button primary" id="save-status">Save status</button>`;
      modalBody.after(footer);
      byId("modal-status").value = report.status || "BARU";
      byId("save-status").addEventListener("click", updateReportStatus);
    } catch (error) {
      if (state.currentReportId === id && !modal.hidden) modalBody.innerHTML = `<div class="error-state">${h(error.message)}</div>`;
    }
  }

  function closeModal() {
    const wasOpen = !byId("report-modal").hidden;
    byId("report-modal").hidden = true;
    if (wasOpen && state.modalReturnFocus?.isConnected) state.modalReturnFocus.focus();
    document.body.style.overflow = "";
    state.currentReportId = null;
  }

  async function updateReportStatus() {
    if (!state.currentReportId) return;
    const status = byId("modal-status").value;
    const button = byId("save-status");
    button.disabled = true;
    try {
      await apiFetch(`/api/reports/${state.currentReportId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      showToast(`Report #${state.currentReportId} updated to ${status}.`);
      closeModal();
      await refreshAll();
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  }

  function handleReportActivation(event) {
    const target = event.target.closest("[data-report-id]");
    if (!target) return;
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openReport(target.dataset.reportId);
  }

  function bindEvents() {
    function selectIncident(event) {
      const target = event.target.closest("[data-select-report], [data-select-mobile]");
      if (!target || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
      event.preventDefault();
      state.selectedIncidentKey = target.dataset.selectReport ? `report:${target.dataset.selectReport}` : `mobile:${target.dataset.selectMobile}`;
      renderReports(); renderMobileSos();
      if (!byId("view-reports").classList.contains("active")) switchView("reports");
    }
    document.addEventListener("click", selectIncident);
    document.addEventListener("keydown", selectIncident);
    document.addEventListener("click", event => {
      const node = event.target.closest("[data-select-node]");
      if (node) { state.selectedNodeId = Number(node.dataset.selectNode); renderNodes(); switchView("nodes"); }
      const reports = event.target.closest("[data-node-reports]");
      if (reports) {
        byId("node-filter").value = reports.dataset.nodeReports; state.reportPage = 1;
        renderReports(); switchView("reports");
      }
      const page = event.target.closest("[data-report-page]");
      if (page && !page.disabled) { state.reportPage = Number(page.dataset.reportPage); renderReports(); }
    });
    byId("report-sort").addEventListener("change", event => { state.sortKey = event.target.value; state.reportPage = 1; renderReports(); });
    byId("report-page-size").addEventListener("change", () => { state.reportPage = 1; renderReports(); });
    document.addEventListener("keydown", event => {
      const modal = byId("report-modal");
      if (event.key !== "Tab" || modal.hidden) return;
      const focusable = all('button:not(:disabled), select, input, [tabindex="0"]', modal);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    all(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    all("[data-go-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.goView)));
    byId("mobile-menu").addEventListener("click", openSidebar);
    byId("sidebar-overlay").addEventListener("click", closeSidebar);
    byId("refresh-button").addEventListener("click", () => refreshAll({ manual: true }));
    byId("modal-close").addEventListener("click", closeModal);
    byId("report-modal").addEventListener("click", (event) => { if (event.target === byId("report-modal")) closeModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeModal(); closeSidebar(); } });
    document.addEventListener("click", handleReportActivation);
    document.addEventListener("keydown", handleReportActivation);
    document.addEventListener("click", (event) => {
      const position = event.target.closest("[data-map-position]");
      if (position) focusMapPosition(position.dataset.mapPosition);
    });
    all("[data-map-filter]").forEach((button) => button.addEventListener("click", () => {
      state.mapFilter = button.dataset.mapFilter || "all";
      liveMaps.forEach((record) => { record.didFit = false; });
      renderMaps();
    }));
    all("[data-map-fit]").forEach((button) => button.addEventListener("click", () => fitMapMarkers(button.dataset.mapFit)));
    window.addEventListener("resize", () => liveMaps.forEach((record) => record.map.invalidateSize()));

    ["report-search", "condition-filter", "status-filter", "sos-filter", "node-filter", "time-filter"].forEach((id) => {
      byId(id).addEventListener(id === "report-search" ? "input" : "change", () => { state.reportPage = 1; renderReports(); });
    });
    byId("clear-filters").addEventListener("click", () => {
      state.reportPage = 1;
      byId("report-search").value = "";
      ["condition-filter", "status-filter", "sos-filter", "node-filter", "time-filter"].forEach((id) => { byId(id).value = ""; });
      renderReports();
    });
    byId("reports-table").addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort]");
      if (!header) return;
      state.reportPage = 1;
      const key = header.dataset.sort;
      if (state.sortKey === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
      else { state.sortKey = key; state.sortDirection = "asc"; }
      renderReports();
    });
  }

  function initialize() {
    bindEvents();
    const hashView = window.location.hash.replace("#", "");
    if (viewMeta[hashView]) switchView(hashView);
    refreshAll();
    window.setInterval(refreshAll, POLL_INTERVAL_MS);
    refreshIncidents();
    window.setInterval(refreshIncidents, INCIDENT_POLL_INTERVAL_MS);
    refreshMapSnapshot();
    window.setInterval(refreshMapSnapshot, POLL_INTERVAL_MS);
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
