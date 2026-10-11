(function () {
  "use strict";
  const ui = window.RescueNetUI;
  const { byId, h, display, numberDisplay, formatShortTime, relativeTime, icon, nodeBadge, nodeTone } = ui;
  let topology;

  function topologyPresentation(node) {
    const tone = nodeTone(node);
    return { tone, label: tone === "online" ? "Online" : tone === "stale" ? "Stale" : "Unknown",
      caption: tone === "online" ? "Heartbeat recent" : tone === "stale" ? relativeTime(node.heartbeat_seconds_ago) : "Status not known" };
  }

  // Layout coordinates only: these curves are logical associations, not measured routes.
  function linkPath(start, end) {
    const bend = Math.max(24, (end.y - start.y) * .48);
    const n = value => Number(value.toFixed(1));
    return `M ${n(start.x)} ${n(start.y)} C ${n(start.x)} ${n(start.y + bend)}, ${n(end.x)} ${n(end.y - bend)}, ${n(end.x)} ${n(end.y)}`;
  }

  function createTopology() {
    const canvas = byId("mesh-topology"), container = byId("topology-nodes"), links = byId("mesh-links");
    const gateway = byId("mesh-gateway"), gatewayDevice = byId("mesh-gateway-device");
    const slots = new Map(), paths = new Map();
    let pendingFrame = 0;
    function measure() {
      pendingFrame = 0;
      if (!canvas.clientWidth || !canvas.clientHeight) return; // Hidden pages are measured when revealed.
      const head = gatewayDevice.getBoundingClientRect();
      links.setAttribute("viewBox", `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
      // Map viewport coordinates into SVG space, including fractional sizes, transforms,
      // and any scroll offset introduced when the browser brings a focused card into view.
      const matrix = links.getScreenCTM().inverse();
      const toSvg = (x, y) => {
        const point = links.createSVGPoint();
        point.x = x; point.y = y;
        return point.matrixTransform(matrix);
      };
      const start = toSvg(head.left + head.width / 2, head.bottom);
      for (const [key, slot] of slots) {
        const box = slot.querySelector("button").getBoundingClientRect();
        const d = linkPath(start, toSvg(box.left + box.width / 2, box.top));
        const path = paths.get(key);
        if (path.getAttribute("d") !== d) path.setAttribute("d", d);
      }
    }
    function scheduleMeasure() {
      if (!pendingFrame) pendingFrame = window.requestAnimationFrame(measure);
    }
    if (window.ResizeObserver) {
      const observer = new window.ResizeObserver(scheduleMeasure);
      observer.observe(canvas);
      observer.observe(container);
      observer.observe(gateway);
    } else {
      window.addEventListener("resize", scheduleMeasure);
      // Revealing a hidden view also needs remeasurement in browsers without ResizeObserver.
      if (window.MutationObserver) new window.MutationObserver(scheduleMeasure)
        .observe(byId("view-nodes"), { attributes: true, attributeFilter: ["class"] });
    }
    function update(nodes, selectedId, serial) {
      const keys = new Set(nodes.map(node => String(node.node_id)));
      for (const [key, slot] of slots) {
        if (keys.has(key)) continue;
        slot.remove(); paths.get(key).remove(); slots.delete(key); paths.delete(key);
      }
      if (!nodes.length) {
        ui.setHtml("topology-nodes", '<div class="empty-state">No observed Field Nodes.</div>');
      } else {
        for (const child of Array.from(container.children)) if (!child.hasAttribute("data-mesh-node")) child.remove();
      }
      nodes.forEach((node, index) => {
        const key = String(node.node_id), presentation = topologyPresentation(node);
        let slot = slots.get(key), path = paths.get(key);
        if (!slot) {
          slot = document.createElement("div");
          slot.dataset.meshNode = key;
          slot.innerHTML = `<span class="mesh-halo" aria-hidden="true"></span><button type="button" class="topology-device">${icon("i-antenna")}<strong></strong><span class="mesh-node-state"></span><small class="mesh-node-note"></small></button>`;
          slot.querySelector("button").dataset.selectNode = key;
          slot.querySelector("strong").textContent = `Field Node ${key}`;
          slots.set(key, slot);
          path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("data-mesh-link", key);
          links.appendChild(path);
          paths.set(key, path);
        }
        // Keep keyed cards/paths alive across polls: preserve keyboard focus and animation progress.
        if (container.children[index] !== slot) container.insertBefore(slot, container.children[index] || null);
        const selected = key === String(selectedId), button = slot.querySelector("button");
        slot.className = `mesh-device-slot ${presentation.tone}`;
        button.className = `topology-device ${presentation.tone}${selected ? " selected" : ""}`;
        button.setAttribute("aria-pressed", String(selected));
        slot.querySelector(".mesh-node-state").textContent = presentation.label;
        slot.querySelector(".mesh-node-note").textContent = presentation.caption;
        const pathClass = `mesh-link mesh-link--${presentation.tone}`;
        if (path.getAttribute("class") !== pathClass) path.setAttribute("class", pathClass);
      });
      const ready = serial?.status === "ready";
      byId("topology-gateway-state").textContent = serial ? serial.status.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "Unknown";
      gateway.classList.toggle("active", ready);
      scheduleMeasure();
    }
    return { update };
  }
  function render(state) {
    if (!Array.isArray(state.nodes)) return;
    const nodes = state.nodes;
    if (!nodes.some(n => String(n.node_id) === String(state.selectedNodeId))) state.selectedNodeId = nodes[0]?.node_id ?? null;
    const gateway = state.health?.gateway_serial, ready = gateway?.status === "ready";
    if (!topology) topology = createTopology();
    topology.update(nodes, state.selectedNodeId, gateway);
    const selected = nodes.find(n => String(n.node_id) === String(state.selectedNodeId));
    ui.setHtml("node-detail-grid", selected ? detail(selected, state) : '<div class="empty-state">No node telemetry is available yet.</div>');
    ui.setHtml("node-roster", nodes.length ? `<table class="data-table"><thead><tr><th>Node</th><th>Device status</th><th>Heartbeat</th><th>Last report</th><th>Gateway RX RSSI</th><th>Hop</th><th>Packet ID</th><th>Pending</th><th>Actions</th></tr></thead><tbody>
      ${nodes.map(n => `<tr class="${n.node_id === state.selectedNodeId ? "selected" : ""}"><td class="primary-cell">${icon("i-antenna")} Field Node ${h(n.node_id)}</td><td>${nodeBadge(n)}</td><td>${h(relativeTime(n.heartbeat_seconds_ago))}</td><td>${h(formatShortTime(n.last_new_report_at))}</td><td>${display(n.last_rssi," dBm")}</td><td>${display(n.last_hop)}</td><td>${display(n.last_pkt_id)}</td><td>${n.heartbeat_seconds_ago == null ? "Unknown" : display(n.pending_count)}</td><td><button class="button secondary" data-select-node="${h(n.node_id)}">View details</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty-state">Node roster is empty. Received reports and heartbeats will populate it.</div>');
    const known = nodes.filter(n => n.heartbeat_seconds_ago != null), online = nodes.filter(n => n.device_status === "online").length;
    const summary = [["Nodes online", `${online} / ${nodes.length}`, "Observed devices · heartbeat status", "healthy", "i-antenna"],
      ["Received reports", state.stats?.total_reports ?? "Not available", "All report records · PWA stored separately", "", "i-report"],
      ["Pending reports", known.length ? known.reduce((sum,n) => sum + Number(n.pending_count || 0),0) : "Unknown", `Reported by ${known.length} of ${nodes.length} observed nodes`, "attention", "i-report"],
      ["Gateway serial", gateway ? gateway.status.replace(/_/g," ") : "Unknown", "Serial readiness · radio reachability separate", ready ? "healthy" : "", "i-antenna"]];
    ui.setHtml("node-summary", summary.map(([label,value,caption,tone,symbol]) => `<article class="stat-card ${tone}"><span class="stat-icon">${icon(symbol)}</span><div><span class="stat-label">${label}</span><strong>${h(value)}</strong><small>${caption}</small></div></article>`).join(""));
  }
  function detail(n, state) {
    const row = (label,value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const location = state.mapSnapshot?.positions?.find(p => p.type === "field_node" && p.node_id === n.node_id);
    return `<div class="panel-header"><h2>Selected node · Field Node ${h(n.node_id)}</h2>${nodeBadge(n)}</div>
      <div class="selected-node-banner ${nodeTone(n)}"><span>${icon("i-antenna")}</span><div><h3>Field Node ${h(n.node_id)}</h3><small>Observed mesh device</small></div></div>
      <dl class="node-telemetry">${row("Last heartbeat",h(relativeTime(n.heartbeat_seconds_ago)))}${row("Last report activity",h(formatShortTime(n.last_new_report_at)))}
      ${row("Recently active report", n.recently_active ? "Yes · within report threshold" : "No recent report")}
      ${row("Last packet ID",display(n.last_pkt_id))}${row("Gateway RX RSSI / SNR",`${display(n.last_rssi," dBm")} / ${numberDisplay(n.last_snr,1," dB")}`)}
      ${row("Hop count",display(n.last_hop))}${row("Mesh / Gateway",n.heartbeat_seconds_ago == null ? "Unknown" : `${n.mesh_synced ? "Synchronized" : "Unsynchronized"} / ${n.gateway_found ? "Found" : "Not found"}`)}
      ${row("Pending reports",n.heartbeat_seconds_ago == null ? "Unknown" : display(n.pending_count))}</dl>
      <div class="detail-actions"><button class="button secondary" data-node-reports="${h(n.node_id)}">View reports</button>
      <button class="button secondary" ${location ? `data-map-position="${h(location.id)}"` : 'disabled title="No GPS position has reached the server"'}>Locate on map</button></div>
      <p class="panel-footnote">Online/stale uses the server heartbeat status. Report activity does not prove the device is currently online.</p>`;
  }
  ui.pages.nodes = { render, detail, topologyPresentation, linkPath };
})();
