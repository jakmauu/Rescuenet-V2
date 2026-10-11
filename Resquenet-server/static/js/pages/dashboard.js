(function () {
  "use strict";
  const ui = window.RescueNetUI;
  const { byId, h, display, numberDisplay, formatShortTime, relativeTime, badge, icon, nodeBadge, nodeTone } = ui;
  function renderStats(state) {
    if (!state.stats) return;
    for (const [id, key] of [["stat-total","total_reports"],["stat-active","recently_active_nodes"],["stat-critical","critical_reports"],["stat-unhandled","unhandled_reports"]])
      byId(id).textContent = state.stats[key] == null ? "Not available" : Number(state.stats[key]).toLocaleString();
  }
  function renderNodes(state) {
    if (!Array.isArray(state.nodes)) return;
    ui.setHtml("dashboard-nodes", state.nodes.length ? state.nodes.map(node => `<button class="compact-node ${nodeTone(node)}" data-select-node="${h(node.node_id)}">
      <span class="compact-node-header"><strong>${icon("i-antenna")}Node ${h(node.node_id)}</strong>${nodeBadge(node)}</span>
      <span class="node-meta"><span><span>Last heartbeat</span><strong>${h(relativeTime(node.heartbeat_seconds_ago))}</strong></span>
      <span><span>Report activity</span><strong>${h(relativeTime(node.seconds_ago))}</strong></span>
      <span><span>Gateway RX RSSI / SNR</span><strong>${display(node.last_rssi," dBm")} / ${numberDisplay(node.last_snr,1," dB")}</strong></span>
      <span><span>Hop / packet</span><strong>${display(node.last_hop)} / ${display(node.last_pkt_id)}</strong></span>
      <span><span>Pending / mesh</span><strong>${node.heartbeat_seconds_ago == null ? "Unknown" : `${display(node.pending_count)} / ${node.mesh_synced ? "Synced" : "Unsynced"}`}</strong></span></span></button>`).join("") : '<div class="empty-state">No Field Nodes have been observed by the server.</div>');
  }
  function renderGateway(state) {
    if (!state.health) return;
    const gateway = state.health.gateway_serial || { status: "not_available", details: {} }, details = gateway.details || {};
    const ready = gateway.status === "ready";
    ui.setHtml("gateway-summary", `<div class="gateway-state"><span class="gateway-icon ${ready ? "ready" : ""}">${icon("i-antenna")}</span><div><strong>Gateway ${ui.operationalBadge(gateway.status)}</strong><span>USB serial interface</span></div></div>
      <details class="gateway-diagnostics"><summary>Serial diagnostics</summary><div class="gateway-details">
      <div><span>Serial connection</span><strong>${details.serial_connected == null ? "Unknown" : details.serial_connected ? "Connected" : "Disconnected"}</strong></div>
      <div><span>Firmware ready</span><strong>${details.gateway_ready == null ? "Unknown" : details.gateway_ready ? "Ready" : "Not ready"}</strong></div>
      <div><span>Device</span><strong>${display(details.serial_port)}</strong></div><div><span>Last packet</span><strong>${h(formatShortTime(details.last_packet_at))}</strong></div></div></details>`);
  }
  function renderSos(state) {
    if (state.mobileSos === null && state.reports === null) return;
    const rows = ui.incidents(state, true).slice(0, 6);
    ui.setHtml("dashboard-mobile-sos", rows.length ? `<table class="data-table sos-table"><thead><tr><th>ID / request</th><th>Source node</th><th>GPS coordinates</th><th>Received time</th><th>Receipt</th></tr></thead><tbody>
      ${rows.map(item => `<tr class="${item.critical ? "sos-row" : ""}" ${item.mobile ? `data-select-mobile="${h(item.record.request_key)}"` : `data-select-report="${h(item.record.id)}"`} tabindex="0"><td class="primary-cell">${item.mobile ? `PWA · ${h(item.record.request_key.slice(0, 8))}…` : `#${h(item.record.id)}`}</td><td>Field Node ${h(item.node)}</td><td>${item.gps ? `${numberDisplay(item.record.lat,6)}, ${numberDisplay(item.record.lon,6)}` : "Not provided"}</td><td>${h(formatShortTime(item.received))}</td><td>${badge(item.stored ? "Stored on server" : "Storage not confirmed", item.stored ? "success" : "warning")}</td></tr>`).join("")}</tbody></table>` : '<div class="empty-state">No SOS records have reached this server.</div>');
  }
  function renderActivity(state) {
    if (!Array.isArray(state.activity)) return;
    if (!state.activity.length) {
      ui.setHtml("dashboard-activity", `<div class="empty-state">No activity buckets available.</div>`);
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
    ui.setHtml("dashboard-activity", `<div class="chart"><div class="chart-y"><span>${realMaximum}</span><span>${midpoint}</span><span>0</span></div><div class="chart-bars">${bars}</div></div>`);
  }
  ui.pages.dashboard = { renderStats, renderNodes, renderGateway, renderSos, renderActivity };
})();
