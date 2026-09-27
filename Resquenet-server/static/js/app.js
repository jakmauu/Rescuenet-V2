(function () {
  "use strict";

  const mapConfig = window.RESCUENET_MAP_CONFIG || {};
  const POLL_INTERVAL_MS = Number(mapConfig.pollIntervalMs) || 5000;
  const liveMaps = new Map();
  const viewMeta = {
    dashboard: ["Dashboard", "Emergency response and mesh network overview"],
    reports: ["Emergency Reports", "Review and coordinate incident handling"],
    map: ["GPS Map", "Emergency report locations available to the command center"],
    nodes: ["Mesh Nodes", "Field-node report activity and logical topology"],
    system: ["System Status", "Local server, Gateway, and Raspberry Pi health"],
  };

  const state = {
    reports: null,
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
    toastTimer: null,
  };

  const byId = (id) => document.getElementById(id);
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function h(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function display(value, suffix = "") {
    return value === null || value === undefined || value === ""
      ? "Not available"
      : `${h(value)}${suffix}`;
  }

  function numberDisplay(value, digits = 0, suffix = "") {
    const number = Number(value);
    if (!Number.isFinite(number)) return "Not available";
    return `${number.toFixed(digits)}${suffix}`;
  }

  function formatTime(timestamp) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric) || numeric <= 0) return "Not available";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(numeric * 1000));
  }

  function formatShortTime(timestamp) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric) || numeric <= 0) return "Not available";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(numeric * 1000));
  }

  function relativeTime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "Never seen";
    if (value < 60) return `Seen ${Math.floor(value)} sec ago`;
    if (value < 3600) return `Seen ${Math.floor(value / 60)} min ago`;
    if (value < 86400) return `Seen ${Math.floor(value / 3600)} hr ago`;
    return `Seen ${Math.floor(value / 86400)} day ago`;
  }

  function formatUptime(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0) return "Not available";
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function isCritical(report) {
    const condition = String(report.kondisi || "").toUpperCase();
    return Number(report.sos) === 1 || ["KRITIS", "CRITICAL", "DARURAT", "EMERGENCY"].includes(condition);
  }

  function badge(text, style = "") {
    return `<span class="status-badge ${h(style)}">${h(text)}</span>`;
  }

  function operationalBadge(status) {
    const normalized = String(status || "not_available").toLowerCase();
    const good = ["connected", "ready", "running"].includes(normalized);
    const warning = ["connecting"].includes(normalized);
    const label = normalized === "not_available"
      ? "Not available"
      : normalized.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    return badge(label, good ? "success" : warning ? "warning" : "");
  }

  async function apiFetch(path, options = {}) {
    const response = await fetch(path, {
      headers: { Accept: "application/json", ...(options.headers || {}) },
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

  function switchView(name) {
    if (!viewMeta[name]) return;
    all("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === name));
    all(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    byId("page-title").textContent = viewMeta[name][0];
    byId("page-subtitle").textContent = viewMeta[name][1];
    document.title = `${viewMeta[name][0]} · RescueNet`;
    window.history.replaceState(null, "", `#${name}`);
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
    byId("sidebar").classList.add("open");
    byId("sidebar-overlay").classList.add("open");
  }

  function closeSidebar() {
    byId("sidebar").classList.remove("open");
    byId("sidebar-overlay").classList.remove("open");
  }

  function renderStats() {
    if (!state.stats) return;
    byId("stat-total").textContent = Number(state.stats.total_reports || 0).toLocaleString();
    byId("stat-active").textContent = Number(state.stats.recently_active_nodes || 0).toLocaleString();
    byId("stat-critical").textContent = Number(state.stats.critical_reports || 0).toLocaleString();
    byId("stat-unhandled").textContent = Number(state.stats.unhandled_reports || 0).toLocaleString();
  }

  function displayNodes() {
    const realNodes = Array.isArray(state.nodes) ? state.nodes : [];
    const byNode = new Map(realNodes.map((node) => [Number(node.node_id), node]));
    const identifiers = Array.from(new Set([1, 2, 3, ...realNodes.map((node) => Number(node.node_id))])).sort((a, b) => a - b);
    return identifiers.map((identifier) => byNode.get(identifier) || { node_id: identifier, recently_active: false, no_data: true });
  }

  function nodeStateBadge(node) {
    return node.recently_active
      ? badge("Recently Active", "success")
      : badge(node.no_data ? "No Activity" : "Not Recently Active");
  }

  function renderNodes() {
    if (!Array.isArray(state.nodes)) return;
    const nodes = displayNodes();
    byId("dashboard-nodes").innerHTML = nodes.slice(0, 6).map((node) => `
      <div class="compact-node">
        <div class="compact-node-header"><strong>Node ${h(node.node_id)}</strong>${nodeStateBadge(node)}</div>
        <div class="node-meta">
          <div><span>Last seen</span><strong>${h(relativeTime(node.seconds_ago))}</strong></div>
          <div><span>Gateway RX RSSI</span><strong>${node.no_data ? "Not available" : display(node.last_rssi, " dBm")}</strong></div>
          <div><span>Gateway RX SNR</span><strong>${node.no_data ? "Not available" : numberDisplay(node.last_snr, 1, " dB")}</strong></div>
          <div><span>Hop / Packet</span><strong>${node.no_data ? "Not available" : `${h(node.last_hop)} / ${h(node.last_pkt_id)}`}</strong></div>
        </div>
      </div>`).join("");

    byId("topology-nodes").innerHTML = nodes.slice(0, 3).map((node) => `
      <div class="topology-device ${node.recently_active ? "active" : ""}">
        <svg><use href="#i-antenna"/></svg><strong>Node ${h(node.node_id)}</strong>
        <span>${h(node.recently_active ? "Recently active" : node.no_data ? "No activity" : "Not recently active")}</span>
      </div>`).join("");

    byId("node-detail-grid").innerHTML = nodes.map((node) => `
      <article class="node-detail-card">
        <header><strong>Field Node ${h(node.node_id)}</strong>${nodeStateBadge(node)}</header>
        <dl>
          <div><dt>Last seen</dt><dd>${h(relativeTime(node.seconds_ago))}</dd></div>
          <div><dt>Gateway RX RSSI</dt><dd>${node.no_data ? "Not available" : display(node.last_rssi, " dBm")}</dd></div>
          <div><dt>Gateway RX SNR</dt><dd>${node.no_data ? "Not available" : numberDisplay(node.last_snr, 1, " dB")}</dd></div>
          <div><dt>Hop count</dt><dd>${node.no_data ? "Not available" : display(node.last_hop)}</dd></div>
          <div><dt>Last packet ID</dt><dd>${node.no_data ? "Not available" : display(node.last_pkt_id)}</dd></div>
          <div><dt>Last activity</dt><dd>${node.no_data ? "Not available" : h(formatShortTime(node.last_seen))}</dd></div>
        </dl>
      </article>`).join("");
  }

  function renderGateway() {
    if (!state.health) return;
    const gateway = state.health.gateway_serial || { status: "not_available", details: {} };
    const details = gateway.details || {};
    const ready = gateway.status === "ready";
    const summary = `
      <div class="gateway-state">
        <span class="gateway-icon ${ready ? "ready" : ""}"><svg><use href="#i-antenna"/></svg></span>
        <div><strong>Gateway Serial Interface</strong><span>${operationalBadge(gateway.status)}</span></div>
      </div>
      <div class="gateway-details">
        <div><span>Serial connection</span><strong>${details.serial_connected === true ? "Connected" : "Not connected"}</strong></div>
        <div><span>Firmware ready</span><strong>${details.gateway_ready === true ? "Ready" : "Not ready"}</strong></div>
        <div><span>Device</span><strong>${display(details.serial_port)}</strong></div>
        <div><span>Last packet</span><strong>${h(formatShortTime(details.last_packet_at))}</strong></div>
      </div>`;
    byId("gateway-summary").innerHTML = summary;
    byId("topology-gateway-state").textContent = gateway.status === "not_available" ? "Not available" : String(gateway.status).replace(/_/g, " ");
    const gatewayDevice = document.querySelector(".topology-device.gateway");
    if (gatewayDevice) gatewayDevice.classList.toggle("active", ready);
  }

  const reportColumns = [
    ["id", "Database ID"], ["pkt_id", "Packet ID"], ["src_id", "Source Node"],
    ["kondisi", "Condition"], ["jumlah", "Victim Count"], ["hop", "Hop"],
    ["rssi", "Gateway RX RSSI"], ["snr", "Gateway RX SNR"],
    ["received_at", "Received Time"], ["status", "Status"],
  ];

  function reportTableHtml(reports, compact = false) {
    if (!reports.length) return `<div class="empty-state">No reports received yet.</div>`;
    const rows = compact ? reports.slice(0, 6) : reports;
    return `<table class="data-table">
      <thead><tr>${reportColumns.map(([key, label]) => `<th${compact ? "" : ` data-sort="${h(key)}" class="${state.sortKey === key ? `sort-active ${state.sortDirection === "asc" ? "asc" : ""}` : ""}"`}>${h(label)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((report) => `
        <tr data-report-id="${h(report.id)}" class="${Number(report.sos) === 1 ? "sos-row" : ""}" tabindex="0">
          <td class="primary-cell">#${h(report.id)}</td>
          <td>${Number(report.sos) === 1 ? `<span class="sos-flag"><svg><use href="#i-warning"/></svg>${h(report.pkt_id)}</span>` : h(report.pkt_id)}</td>
          <td>Node ${h(report.src_id)}</td>
          <td>${display(report.kondisi)}</td>
          <td>${display(report.jumlah)}</td>
          <td>${display(report.hop)}</td>
          <td>${display(report.rssi, " dBm")}</td>
          <td>${numberDisplay(report.snr, 1, " dB")}</td>
          <td>${h(formatShortTime(report.received_at))}</td>
          <td>${badge(report.status || "BARU", String(report.status || "baru").toLowerCase())}</td>
        </tr>`).join("")}</tbody>
    </table>`;
  }

  function updateFilterOptions(selectId, values, prefix) {
    const select = byId(selectId);
    const current = select.value;
    const options = [`<option value="">${h(prefix)}</option>`, ...values.map((value) => `<option value="${h(value)}">${h(value)}</option>`)].join("");
    if (select.innerHTML !== options) select.innerHTML = options;
    if (values.map(String).includes(current)) select.value = current;
  }

  function filteredReports() {
    if (!Array.isArray(state.reports)) return [];
    const search = byId("report-search").value.trim().toLowerCase();
    const condition = byId("condition-filter").value;
    const status = byId("status-filter").value;
    const sos = byId("sos-filter").value;
    const node = byId("node-filter").value;
    const filtered = state.reports.filter((report) => {
      const haystack = [report.id, report.pkt_id, report.src_id, report.kondisi, report.pesan, report.status].join(" ").toLowerCase();
      return (!search || haystack.includes(search))
        && (!condition || String(report.kondisi) === condition)
        && (!status || String(report.status) === status)
        && (!sos || String(report.sos) === sos)
        && (!node || String(report.src_id) === node);
    });
    const direction = state.sortDirection === "asc" ? 1 : -1;
    return filtered.sort((left, right) => {
      const a = left[state.sortKey];
      const b = right[state.sortKey];
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return String(a ?? "").localeCompare(String(b ?? "")) * direction;
    });
  }

  function renderReports() {
    if (!Array.isArray(state.reports)) return;
    const conditions = Array.from(new Set(state.reports.map((report) => report.kondisi).filter(Boolean))).sort();
    const nodes = Array.from(new Set(state.reports.map((report) => String(report.src_id)).filter(Boolean))).sort((a, b) => Number(a) - Number(b));
    updateFilterOptions("condition-filter", conditions, "All conditions");
    updateFilterOptions("node-filter", nodes, "All nodes");
    const reports = filteredReports();
    byId("reports-table").innerHTML = reportTableHtml(reports, false);
    byId("recent-reports").innerHTML = reportTableHtml(state.reports, true);
    byId("report-count").textContent = `${reports.length} record${reports.length === 1 ? "" : "s"}`;
  }

  function setMapStatus(mapId, text, isError = false) {
    const status = byId(mapId === "dashboard-map" ? "dashboard-map-status" : "full-map-status");
    if (!status) return;
    status.textContent = text;
    status.parentElement.classList.toggle("error", isError);
  }

  function mapPositionVisible(position) {
    if (state.mapFilter === "all") return true;
    if (state.mapFilter === "critical") return Boolean(position.critical);
    return position.type === state.mapFilter;
  }

  function markerText(position) {
    if (position.critical) return "!";
    if (position.type === "field_node") return `N${position.node_id}`;
    if (position.type === "gateway") return "G";
    return String(position.label || "U").trim().charAt(0).toUpperCase() || "U";
  }

  function distanceDisplay(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return "Not available";
    return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
  }

  function mapPopup(position) {
    const freshness = position.freshness === "recent" ? "Recently updated" : position.freshness === "stale" ? "Stale position" : "Old position";
    const rows = [
      ["Status", freshness],
      ["Updated", relativeTime(position.seconds_ago).replace(/^Seen /, "")],
      ["Coordinate", `${Number(position.lat).toFixed(6)}, ${Number(position.lon).toFixed(6)}`],
    ];
    if (position.type === "field_node") {
      rows.push(["Gateway RX", `${display(position.rssi, " dBm")} / ${numberDisplay(position.snr, 1, " dB")}`]);
      rows.push(["Hop", display(position.hop)]);
      rows.push(["Condition", display(position.condition)]);
    } else if (position.type === "mobile_user") {
      rows.push(["GPS accuracy", numberDisplay(position.accuracy, 1, " m")]);
      rows.push(["Via Field Node", display(position.source_node)]);
      rows.push(["Mesh hop", display(position.mesh_hops)]);
      if (position.distance_to_source_m != null) rows.push(["Distance to node", distanceDisplay(position.distance_to_source_m)]);
    } else {
      rows.push(["Source", "Configured location"]);
    }
    return `<div class="map-popup"><h3>${h(position.label)}</h3><dl>${rows.map(([label, value]) => `<dt>${h(label)}</dt><dd>${value}</dd>`).join("")}</dl>${position.critical ? `<p class="popup-alert">SOS / critical condition</p>` : ""}</div>`;
  }

  function ensureMap(mapId) {
    if (liveMaps.has(mapId)) return liveMaps.get(mapId);
    const element = byId(mapId);
    if (!element || typeof window.L === "undefined") {
      const empty = byId(`${mapId}-empty`);
      if (empty) {
        empty.hidden = false;
        empty.innerHTML = "<strong>Map library unavailable</strong>Check the Raspberry Pi internet connection and reload this page.";
      }
      setMapStatus(mapId, "Leaflet unavailable", true);
      return null;
    }
    const center = Array.isArray(mapConfig.defaultCenter) ? mapConfig.defaultCenter : [-6.2, 106.8167];
    const map = window.L.map(element, { zoomControl: true, preferCanvas: true }).setView(center, Number(mapConfig.defaultZoom) || 13);
    const record = { map, layer: window.L.layerGroup().addTo(map), markers: new Map(), didFit: false, tileFailed: false };
    const tiles = window.L.tileLayer(mapConfig.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    tiles.on("tileerror", () => {
      record.tileFailed = true;
      setMapStatus(mapId, "Map tiles unavailable; GPS markers still update", true);
    });
    liveMaps.set(mapId, record);
    return record;
  }

  function fitMapMarkers(mapId) {
    const record = liveMaps.get(mapId);
    if (!record || !record.markers.size) return;
    const bounds = window.L.latLngBounds(Array.from(record.markers.values()).map((marker) => marker.getLatLng()));
    if (bounds.isValid()) record.map.fitBounds(bounds, { padding: [34, 34], maxZoom: 17 });
    record.didFit = true;
  }

  function renderLeafletMap(mapId) {
    const record = ensureMap(mapId);
    if (!record || !state.mapSnapshot) return;
    record.layer.clearLayers();
    record.markers.clear();
    const allPositions = Array.isArray(state.mapSnapshot.positions) ? state.mapSnapshot.positions : [];
    const positions = allPositions.filter(mapPositionVisible);
    const positionById = new Map(positions.map((position) => [position.id, position]));

    (state.mapSnapshot.links || []).forEach((link) => {
      const from = positionById.get(link.from_id);
      const to = positionById.get(link.to_id);
      if (!from || !to) return;
      const line = window.L.polyline([[from.lat, from.lon], [to.lat, to.lon]], {
        color: "#347ebc", weight: 2, opacity: .72, dashArray: "6 5", className: "rescuenet-link",
      });
      if (link.distance_m != null) line.bindTooltip(distanceDisplay(link.distance_m), { sticky: true });
      line.addTo(record.layer);
    });

    positions.forEach((position) => {
      const classes = [position.type, position.freshness, position.critical ? "critical" : ""].filter(Boolean).join(" ");
      const icon = window.L.divIcon({
        className: "rescuenet-div-icon",
        html: `<div class="rescuenet-marker ${h(classes)}"><span>${h(markerText(position))}</span></div>`,
        iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -27], tooltipAnchor: [14, -14],
      });
      const marker = window.L.marker([position.lat, position.lon], { icon, title: position.label });
      marker.bindPopup(mapPopup(position));
      marker.bindTooltip(position.label, { direction: "right", className: "rescuenet-label", opacity: .96 });
      marker.addTo(record.layer);
      record.markers.set(position.id, marker);
    });

    const empty = byId(`${mapId}-empty`);
    if (empty) {
      empty.hidden = positions.length > 0;
      empty.innerHTML = allPositions.length
        ? "<strong>No markers in this filter</strong>Select another filter to display available positions."
        : "<strong>Waiting for valid GPS positions</strong>Field Node and mobile-user markers will appear automatically when data arrives.";
    }
    if (!record.tileFailed) {
      const recent = positions.filter((position) => position.freshness === "recent").length;
      setMapStatus(mapId, `${positions.length} markers · ${recent} recently updated · refresh 5 sec`);
    }
    window.setTimeout(() => record.map.invalidateSize(), 0);
    if (positions.length && !record.didFit) fitMapMarkers(mapId);
  }

  function renderMapList() {
    if (!state.mapSnapshot) return;
    const positions = (state.mapSnapshot.positions || []).filter(mapPositionVisible);
    byId("map-report-list").innerHTML = positions.length ? positions.map((position) => `
      <button class="map-list-item ${position.critical ? "sos" : ""} ${position.type === "mobile_user" ? "mobile" : position.type === "gateway" ? "gateway" : ""}" data-map-position="${h(position.id)}">
        <span class="map-list-pin">${h(markerText(position))}</span><div><strong>${h(position.label)}</strong><span>${h(relativeTime(position.seconds_ago))} · ${Number(position.lat).toFixed(5)}, ${Number(position.lon).toFixed(5)}${position.distance_to_source_m != null ? ` · ${h(distanceDisplay(position.distance_to_source_m))} to node` : ""}</span></div>
      </button>`).join("") : `<div class="empty-state">No GPS positions match this filter.</div>`;
  }

  function renderMaps() {
    if (!state.mapSnapshot) return;
    all("[data-map-filter]").forEach((button) => button.classList.toggle("active", button.dataset.mapFilter === state.mapFilter));
    renderLeafletMap("dashboard-map");
    renderLeafletMap("full-map");
    renderMapList();
  }

  function renderMapFailure(message) {
    ["dashboard-map", "full-map"].forEach((mapId) => {
      const empty = byId(`${mapId}-empty`);
      if (empty) {
        empty.hidden = false;
        empty.innerHTML = `<strong>Position feed unavailable</strong>${h(message)}`;
      }
      setMapStatus(mapId, "Position feed unavailable", true);
    });
  }

  function renderActivity() {
    if (!Array.isArray(state.activity)) return;
    if (!state.activity.length) {
      byId("dashboard-activity").innerHTML = `<div class="empty-state">No activity buckets available.</div>`;
      return;
    }
    const realMaximum = Math.max(0, ...state.activity.map((bucket) => Number(bucket.count) || 0));
    const scaleMaximum = Math.max(1, realMaximum);
    const bars = state.activity.map((bucket) => {
      const count = Number(bucket.count) || 0;
      const height = Math.max(1, (count / scaleMaximum) * 135);
      return `<div class="chart-bar-group"><span class="chart-value">${count}</span><i class="chart-bar" style="height:${height}px"></i><span class="chart-label">${h(bucket.label)}</span></div>`;
    }).join("");
    const midpoint = realMaximum > 0 ? Math.round((realMaximum / 2) * 10) / 10 : "";
    byId("dashboard-activity").innerHTML = `<div class="chart"><div class="chart-y"><span>${realMaximum}</span><span>${midpoint}</span><span>0</span></div><div class="chart-bars">${bars}</div></div>`;
  }

  function serviceCard(icon, title, status) {
    return `<article class="service-card"><span class="service-card-icon"><svg><use href="#${h(icon)}"/></svg></span><strong>${h(title)}</strong>${operationalBadge(status)}</article>`;
  }

  function renderSystem() {
    if (state.health) {
      const health = state.health;
      byId("service-grid").innerHTML = [
        serviceCard("i-server", "Raspberry Pi Server", "running"),
        serviceCard("i-server", "Flask Server", health.flask && health.flask.status),
        serviceCard("i-antenna", "MQTT Broker", health.mqtt && health.mqtt.status),
        serviceCard("i-report", "SQLite Database", health.database && health.database.status),
        serviceCard("i-antenna", "Gateway Serial Interface", health.gateway_serial && health.gateway_serial.status),
      ].join("");
    }
    if (state.system) {
      const metrics = state.system;
      const metric = (label, value, suffix, percent) => `
        <article class="metric-card"><span>${h(label)}</span><strong>${value}</strong>${percent === null ? "" : `<div class="meter"><i style="width:${Math.min(100, Math.max(0, percent))}%"></i></div>`}</article>`;
      const cpu = Number.isFinite(Number(metrics.cpu_percent)) ? Number(metrics.cpu_percent) : null;
      const memory = Number.isFinite(Number(metrics.memory_percent)) ? Number(metrics.memory_percent) : null;
      const disk = Number.isFinite(Number(metrics.disk_percent)) ? Number(metrics.disk_percent) : null;
      byId("metric-grid").innerHTML = [
        metric("CPU Usage", cpu === null ? "Not available" : `${cpu.toFixed(1)}%`, "%", cpu),
        metric("RAM Usage", memory === null ? "Not available" : `${memory.toFixed(1)}%`, "%", memory),
        metric("Disk Usage", disk === null ? "Not available" : `${disk.toFixed(1)}%`, "%", disk),
        metric("CPU Temperature", metrics.temperature_c == null ? "Not available" : `${Number(metrics.temperature_c).toFixed(1)}°C`, "", null),
        metric("System Uptime", h(formatUptime(metrics.uptime_seconds)), "", null),
      ].join("");
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
    state.refreshing = true;
    const button = byId("refresh-button");
    button.classList.add("loading");
    button.disabled = true;

    const requests = [
      ["reports", "/api/reports?limit=1000"],
      ["nodes", "/api/nodes"],
      ["stats", "/api/stats"],
      ["activity", "/api/activity?hours=6"],
      ["health", "/api/health"],
      ["system", "/api/system"],
      ["mapSnapshot", "/api/map/positions"],
    ];
    const results = await Promise.allSettled(requests.map(([, path]) => apiFetch(path)));
    let successes = 0;
    results.forEach((result, index) => {
      const key = requests[index][0];
      if (result.status === "fulfilled") {
        state[key] = result.value;
        successes += 1;
      } else if (state[key] === null) {
        if (key === "reports") renderFailure(["reports-table", "recent-reports"], "Reports API unavailable.");
        if (key === "nodes") renderFailure(["dashboard-nodes", "node-detail-grid"], "Node activity unavailable.");
        if (key === "activity") renderFailure(["dashboard-activity"], "Activity API unavailable.");
        if (key === "health") renderFailure(["gateway-summary", "service-grid"], "Service status unavailable.");
        if (key === "system") renderFailure(["metric-grid"], "System metrics unavailable.");
        if (key === "mapSnapshot") renderMapFailure("The local map API did not respond.");
      }
    });

    setConnection(successes > 0);
    renderStats();
    renderNodes();
    renderGateway();
    renderReports();
    renderMaps();
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
    const modal = byId("report-modal");
    modal.hidden = false;
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
      modalBody.innerHTML = `<div class="error-state">${h(error.message)}</div>`;
    }
  }

  function closeModal() {
    byId("report-modal").hidden = true;
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

  function focusMapPosition(positionId) {
    switchView("map");
    window.setTimeout(() => {
      const record = liveMaps.get("full-map");
      const marker = record && record.markers.get(positionId);
      if (!record || !marker) return;
      record.map.invalidateSize();
      record.map.setView(marker.getLatLng(), Math.max(record.map.getZoom(), 16), { animate: true });
      marker.openPopup();
    }, 100);
  }

  function bindEvents() {
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

    ["report-search", "condition-filter", "status-filter", "sos-filter", "node-filter"].forEach((id) => {
      byId(id).addEventListener(id === "report-search" ? "input" : "change", renderReports);
    });
    byId("clear-filters").addEventListener("click", () => {
      byId("report-search").value = "";
      ["condition-filter", "status-filter", "sos-filter", "node-filter"].forEach((id) => { byId(id).value = ""; });
      renderReports();
    });
    byId("reports-table").addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort]");
      if (!header) return;
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
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
