(function () {
  "use strict";
  const ui = window.RescueNetUI;
  const { byId, h, display, numberDisplay, formatTime, formatShortTime, badge, icon, isCritical } = ui;
  const observed = new Map();

  function filter(records, values, sortKey = "received_at", direction = "desc", now = Date.now() / 1000) {
    const search = (values.search || "").trim().toLowerCase();
    return records.filter(report => {
      const haystack = [report.id, report.pkt_id, report.src_id, report.kondisi, report.pesan, report.status, report.delivery_key].join(" ").toLowerCase();
      return (!search || haystack.includes(search))
        && (!values.condition || String(report.kondisi) === values.condition)
        && (!values.status || String(report.status) === values.status)
        && (!values.sos || String(report.sos) === values.sos)
        && (!values.node || String(report.src_id) === values.node)
        && (!values.hours || Number(report.received_at) >= now - Number(values.hours) * 3600);
    }).sort((a, b) => {
      const sign = direction === "asc" ? 1 : -1;
      if (typeof a[sortKey] === "number" && typeof b[sortKey] === "number") return (a[sortKey] - b[sortKey]) * sign;
      return String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? "")) * sign;
    });
  }

  function table(reports, state, compact = false) {
    if (!reports.length) return '<div class="empty-state">No reports match this view.</div>';
    const columns = [["id", "ID"], ["pkt_id", "Packet ID"], ["src_id", "Source node"], ["kondisi", "Condition"], ["received_at", "Received time"], ["status", "Status"]];
    return `<table class="data-table"><thead><tr>${columns.map(([key, label]) => `<th ${compact ? "" : `data-sort="${key}" aria-sort="${state.sortKey === key ? state.sortDirection === "asc" ? "ascending" : "descending" : "none"}" class="${state.sortKey === key ? `sort-active ${state.sortDirection === "asc" ? "asc" : ""}` : ""}"`}>${compact ? label : `<button type="button">${label}</button>`}</th>`).join("")}</tr></thead>
      <tbody>${reports.map(report => `<tr class="${isCritical(report) ? "sos-row" : ""} ${state.selectedIncidentKey === `report:${report.id}` ? "selected" : ""}" data-select-report="${h(report.id)}" tabindex="0" aria-label="View report ${h(report.id)}">
      <td class="primary-cell">${isCritical(report) ? `<span class="condition-dot critical"></span>` : ""}#${h(report.id)}</td>
      <td>${display(report.pkt_id)}</td><td>Node ${h(report.src_id)}</td>
      <td><span class="condition-dot ${isCritical(report) ? "critical" : String(report.kondisi).toUpperCase() === "AMAN" ? "healthy" : "normal"}"></span>${display(report.kondisi)}</td>
      <td>${h(formatShortTime(report.received_at))}</td><td>${badge(report.status || "Unknown", String(report.status || "").toLowerCase())}</td></tr>`).join("")}</tbody></table>`;
  }
  function updateOptions(id, values, label) {
    const select = byId(id), current = select.value;
    const html = `<option value="">${label}</option>${values.map(value => `<option value="${h(value)}">${h(value)}</option>`).join("")}`;
    if (select.innerHTML !== html) select.innerHTML = html;
    if (values.includes(current)) select.value = current;
  }
  function pageSlice(records, page, size) {
    const pages = Math.max(1, Math.ceil(records.length / size));
    const current = Math.max(1, Math.min(pages, page));
    return { rows: records.slice((current - 1) * size, current * size), page: current, pages };
  }

  function render(state) {
    if (!Array.isArray(state.reports)) return;
    const records = state.reports;
    updateOptions("condition-filter", [...new Set(records.map(r => r.kondisi).filter(Boolean))].sort(), "All conditions");
    updateOptions("node-filter", [...new Set(records.map(r => String(r.src_id)))].sort((a, b) => Number(a) - Number(b)), "All nodes");
    const matches = filter(records, { search: byId("report-search").value, condition: byId("condition-filter").value,
      status: byId("status-filter").value, sos: byId("sos-filter").value, node: byId("node-filter").value, hours: byId("time-filter").value }, state.sortKey, state.sortDirection);
    const size = Number(byId("report-page-size").value) || 15;
    const result = pageSlice(matches, state.reportPage || 1, size);
    state.reportPage = result.page;
    ui.setHtml("reports-table", table(result.rows, state));
    ui.setHtml("recent-reports", table(records.slice(0, 6), state, true));
    byId("report-count").textContent = `${matches.length} records`;
    byId("report-range").textContent = matches.length ? `Showing ${(result.page - 1) * size + 1}–${Math.min(result.page * size, matches.length)} of ${matches.length}` : "No matching reports";
    byId("report-sort").value = state.sortKey;
    const pageNumbers = Array.from(new Set([1, result.page - 1, result.page, result.page + 1, result.pages])).filter(p => p >= 1 && p <= result.pages).sort((a,b) => a-b);
    ui.setHtml("report-pagination", `<button data-report-page="${result.page - 1}" aria-label="Previous page" ${result.page === 1 ? "disabled" : ""}>‹</button>${pageNumbers.map(p => `<button data-report-page="${p}" ${p === result.page ? 'aria-current="page"' : ""}>${p}</button>`).join("")}<button data-report-page="${result.page + 1}" aria-label="Next page" ${result.page === result.pages ? "disabled" : ""}>›</button>`);
    const summaries = [["Open", records.filter(r => r.status === "BARU").length, "critical"], ["Critical", records.filter(isCritical).length, "critical"], ["Resolved", records.filter(r => r.status === "SELESAI").length, "healthy"]];
    ui.setHtml("report-summary", summaries.map(([label, count, tone]) => `<article class="summary-card ${tone}"><span class="summary-icon">${icon(label === "Resolved" ? "i-report" : "i-warning")}</span><div><span>${label}</span><strong>${count}</strong></div><small>Loaded reports</small></article>`).join(""));
    renderDetail(state);
  }

  function mobileSosHtml(events, state) {
    if (!events.length) return '<div class="empty-state">No PWA SOS has reached this server.</div>';
    return `<div class="mobile-sos-list">${events.slice(0, 10).map(event => `<button class="mobile-sos-item ${state.selectedIncidentKey === `mobile:${event.request_key}` ? "selected" : ""}" data-select-mobile="${h(event.request_key)}">
      <span class="mobile-sos-heading"><strong>${icon("i-warning")} SOS · Field Node ${h(event.source_node)}</strong>${badge(event.delivery_state === "STORED" ? "Stored on server" : "Storage not confirmed", event.delivery_state === "STORED" ? "success" : "warning")}</span>
      <span class="mobile-sos-meta"><span>${event.has_gps ? `${numberDisplay(event.lat, 6)}, ${numberDisplay(event.lon, 6)}` : "No GPS provided"}</span><span>${h(formatShortTime(event.received_at))}</span></span>
      <small>Request ${h(event.request_key)}</small></button>`).join("")}</div>`;
  }

  function detailHtml(item, visibleAt) {
    const r = item.record;
    const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    return `<div class="panel-header"><div><h2>${h(item.title)} · Field Node ${h(item.node)}</h2><p>${item.mobile ? "Mobile request" : `Report #${h(r.id)}`}</p></div>${badge(item.stored ? "Stored on server" : "Storage not confirmed", item.stored ? "success" : "warning")}</div>
      ${item.critical ? '<div class="critical-banner">Critical incident</div>' : ""}
      <dl class="incident-fields">${row("GPS", item.gps ? `${numberDisplay(r.lat, 6)}, ${numberDisplay(r.lon, 6)}` : "Not provided")}
      ${row(item.mobile ? "Request ID" : "Delivery key", display(item.mobile ? r.request_key : r.delivery_key))}
      ${row("Server received", h(formatTime(item.received)))}${row("Hop count", display(item.mobile ? r.mesh_hops : r.hop))}</dl>
      <section class="receipt-timeline"><h3>Receipt timeline</h3>
        <div class="timeline-step unknown"><span class="timeline-dot">?</span><div><strong>Received by Field Node</strong><small>Acceptance time is not supplied by this API.</small></div></div>
        <div class="timeline-step ${item.stored ? "confirmed" : "unknown"}"><span class="timeline-dot">${item.stored ? "✓" : "?"}</span><div><strong>${item.stored ? "Stored on server" : "Storage not confirmed"}</strong><small>${h(formatTime(item.received))} · server receipt time</small></div></div>
        <div class="timeline-step confirmed"><span class="timeline-dot">✓</span><div><strong>Visible on this dashboard</strong><small>${h(formatTime(visibleAt))} · observed in this browser session</small></div></div>
      </section>
      <h3 class="detail-section-title">Additional information</h3><dl class="incident-fields">
      ${row("Source node", `Field Node ${h(item.node)}`)}${row("Packet / database ID", item.mobile ? `Mobile #${h(r.id)}` : `${display(r.pkt_id)} / #${h(r.id)}`)}
      ${row("Condition", item.mobile ? "SOS" : display(r.kondisi))}${row("Handling status", item.mobile ? "Not provided for PWA requests" : badge(r.status || "Unknown", String(r.status || "").toLowerCase()))}
      ${row("Gateway RX RSSI / SNR", `${display(r.rssi, " dBm")} / ${numberDisplay(r.snr, 1, " dB")}`)}
      ${row(item.mobile ? "GPS accuracy" : "People reported", item.mobile ? numberDisplay(r.accuracy, 1, " m") : display(r.jumlah))}</dl>
      ${item.mobile ? `<p class="detail-message">User: ${h(r.name || "Not provided")}</p>` : `<p class="detail-message">${h(r.pesan || "No message provided")}</p><button class="button primary" data-report-id="${h(r.id)}">Full details &amp; update status</button>`}
      <p class="panel-footnote">Server storage confirms receipt. It does not confirm that a responder has taken action.</p>`;
  }

  function renderDetail(state) {
    const available = ui.incidents(state);
    let item = available.find(r => r.key === state.selectedIncidentKey);
    if (!item && !state.selectedIncidentKey && available.length) { item = available[0]; state.selectedIncidentKey = item.key; }
    if (!item) {
      ui.setHtml("selected-report", '<div class="empty-state">Select an available report to view its details.</div>');
      return;
    }
    if (!observed.has(item.key)) observed.set(item.key, Date.now() / 1000);
    ui.setHtml("selected-report", detailHtml(item, observed.get(item.key)));
  }

  function renderMobile(state) {
    if (state.mobileSos === null) return;
    ui.setHtml("reports-mobile-sos", mobileSosHtml(state.mobileSos, state));
    renderDetail(state);
  }
  ui.pages.reports = { render, renderMobile, renderDetail, filter, table, detailHtml, pageSlice };
})();
