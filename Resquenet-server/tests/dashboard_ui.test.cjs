const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadUi(document) {
  const context = vm.createContext({ window: {}, document, Intl, Date, console });
  for (const file of ["ui.js", "pages/reports.js", "pages/dashboard.js", "pages/mesh_nodes.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/js", file), "utf8"), context, { filename: file });
  return context.window.RescueNetUI;
}
test("missing telemetry remains unknown while real zero values are retained", () => {
  const ui = loadUi();
  assert.equal(ui.numberDisplay(null, 1, " dB"), "Not available");
  assert.equal(ui.relativeTime(null), "Unknown");
  assert.equal(ui.formatUptime(null), "Not available");
  assert.equal(ui.numberDisplay(0, 1, " dB"), "0.0 dB");
  assert.equal(ui.relativeTime(0), "Seen 0 sec ago");
  assert.match(ui.nodeBadge({ recently_active: true }), /Unknown/);
  assert.match(ui.nodeBadge({ device_status: "online" }), /Online/);
});
test("unchanged presentation does not replace focused DOM during polling", () => {
  let writes = 0, html = "initial";
  const target = { get innerHTML() { return html; }, set innerHTML(value) { writes++; html = value; } };
  const ui = loadUi({getElementById: () => target});
  ui.setHtml("test-table", "initial");
  assert.equal(writes, 0);
  ui.setHtml("test-table", "updated");
  ui.setHtml("test-table", "updated");
  assert.equal(writes, 1);
});
test("portal reports and PWA SOS use independent identifiers and received node IDs", () => {
  const ui = loadUi();
  const state = { reports: [{ id: 1, src_id: 7, sos: 1, received_at: 100 }], mobileSos: [{ id: 1, request_key: "request-node-2", source_node: 2, event_type: "SOS", delivery_state: "STORED", received_at: 200 }] };
  const items = ui.incidents(state, true);
  assert.equal(items.length, 2);
  assert.equal(items[0].node, 2);
  assert.equal(items[0].key, "mobile:request-node-2");
  assert.equal(items[1].key, "report:1");
});
test("receipt details never invent Field Node acceptance or responder confirmation", () => {
  const ui = loadUi();
  const record = { id: 5, request_key: "request", source_node: 2, event_type: "SOS", delivery_state: "STORED", received_at: 100, event_timestamp: 90, has_gps: 0, name: "<script>alert(1)</script>" };
  const html = ui.pages.reports.detailHtml(ui.incident(record, true), 200);
  assert.match(html, /Field Node 2/);
  assert.match(html, /Acceptance time is not supplied/);
  assert.match(html, /Stored on server/);
  assert.match(html, /Not provided for PWA requests/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const unconfirmed = ui.pages.reports.detailHtml(ui.incident({ ...record, delivery_state: "QUEUED" }, true), 200);
  assert.match(unconfirmed, /Storage not confirmed/);
  assert.doesNotMatch(unconfirmed, /<strong>Stored on server/);
});
test("report filtering includes time, node, status, SOS and key without mutating records", () => {
  const ui = loadUi();
  const records = [{ id: 1, src_id: 2, sos: 1, kondisi: "KRITIS", status: "BARU", received_at: 9900, delivery_key: "abc-key" }, { id: 2, src_id: 3, sos: 0, kondisi: "AMAN", status: "SELESAI", received_at: 100 }];
  const matches = ui.pages.reports.filter(records, { search: "abc-key", node: "2", sos: "1", status: "BARU", condition: "KRITIS", hours: "1" }, "received_at", "desc", 10000);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 1);
  assert.equal(records[0].id, 1);
  assert.equal(ui.pages.reports.filter(records, { hours: "1" }, "received_at", "desc", 10000).length, 1);
  assert.equal(ui.pages.reports.filter(records, { node: "4" }).length, 0);
});
test("pagination remains valid when live updates or filters shrink the list", () => {
  const ui = loadUi();
  const records = Array.from({length: 31}, (_,i) => ({id: i+1}));
  const second = ui.pages.reports.pageSlice(records, 2, 15);
  assert.equal(second.rows[0].id, 16);
  assert.equal(second.pages, 3);
  assert.equal(ui.pages.reports.pageSlice(records.slice(0, 2), 3, 15).page, 1);
});
test("mesh animation presentation uses device status, not recent reports or mesh readiness", () => {
  const {topologyPresentation} = loadUi().pages.nodes;
  const online = topologyPresentation({node_id: 27, device_status: "online", mesh_synced: false, gateway_found: false});
  assert.equal(online.tone, "online");
  assert.equal(online.label, "Online");
  const stale = topologyPresentation({device_status: "stale", heartbeat_seconds_ago: 7200, recently_active: true});
  assert.equal(stale.tone, "stale");
  assert.equal(stale.label, "Stale");
  assert.equal(stale.caption, "Seen 2 hr ago");
  for (const status of [undefined, null, "unknown", "offline", "unsupported"]) {
    const unknown = topologyPresentation({device_status: status, recently_active: true, mesh_synced: true});
    assert.equal(unknown.tone, "unknown");
    assert.equal(unknown.label, "Unknown");
    assert.equal(unknown.caption, "Status not known");
  }
});
test("logical link geometry terminates at supplied card positions without assuming three nodes", () => {
  const {linkPath} = loadUi().pages.nodes;
  const center = linkPath({x: 200, y: 100}, {x: 200, y: 280});
  assert.match(center, /^M 200 100 C 200 /);
  assert.match(center, /, 200 280$/);
  const wrapped = linkPath({x: 200, y: 100}, {x: 43.123, y: 460.456});
  assert.match(wrapped, /^M 200 100 /);
  assert.match(wrapped, /, 43\.1 460\.5$/);
  assert.doesNotMatch(wrapped, /NaN|Infinity/);
});
