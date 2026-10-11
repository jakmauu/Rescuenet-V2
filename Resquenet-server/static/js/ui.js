(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  function setHtml(id, html) {
    const target = byId(id);
    if (target.innerHTML !== html) target.innerHTML = html;
  }
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
    if (value == null || value === "") return "Not available";
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
    if (seconds == null || seconds === "") return "Unknown";
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "Never seen";
    if (value < 60) return `Seen ${Math.floor(value)} sec ago`;
    if (value < 3600) return `Seen ${Math.floor(value / 60)} min ago`;
    if (value < 86400) return `Seen ${Math.floor(value / 3600)} hr ago`;
    return `Seen ${Math.floor(value / 86400)} day ago`;
  }

  function formatUptime(seconds) {
    if (seconds == null || seconds === "") return "Not available";
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


  function icon(name) { return `<svg aria-hidden="true"><use href="#${h(name)}"/></svg>`; }
  function nodeTone(node) { return ["online", "stale"].includes(node.device_status) ? node.device_status : "unknown"; }
  function nodeBadge(node) {
    const tone = nodeTone(node);
    return badge(tone === "online" ? "Online" : tone === "stale" ? "Device stale" : "Unknown", tone === "online" ? "success" : tone === "stale" ? "warning" : "");
  }
  function incident(record, mobile = false) {
    return {
      key: mobile ? `mobile:${record.request_key}` : `report:${record.id}`,
      record, mobile, node: mobile ? record.source_node : record.src_id,
      received: record.received_at, gps: Number(record.has_gps) === 1,
      critical: mobile ? record.event_type === "SOS" : isCritical(record),
      stored: mobile ? record.delivery_state === "STORED" : true,
      title: mobile ? "PWA SOS" : Number(record.sos) === 1 ? "Portal / device SOS" : "Emergency report",
    };
  }
  function incidents(state, sosOnly = false) {
    const reports = (state.reports || []).filter(r => !sosOnly || Number(r.sos) === 1).map(r => incident(r));
    const mobile = (state.mobileSos || []).map(r => incident(r, true));
    return [...reports, ...mobile].sort((a, b) => Number(b.received) - Number(a.received));
  }
  window.RescueNetUI = { byId, all, setHtml, h, display, numberDisplay, formatTime, formatShortTime, relativeTime,
    formatUptime, isCritical, badge, operationalBadge, icon, nodeTone, nodeBadge, incident, incidents, pages: {} };
})();
