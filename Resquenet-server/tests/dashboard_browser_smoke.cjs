/* Run with RESCUENET_PLAYWRIGHT_PATH pointing at a local Playwright installation.
   The child server uses a disposable fixture database; no hardware/services are started. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {chromium} = require(process.env.RESCUENET_PLAYWRIGHT_PATH || "playwright");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.RESCUENET_SMOKE_PORT) || 5056;
const base = `http://127.0.0.1:${port}`;
const output = process.env.RESCUENET_SCREENSHOT_DIR || path.join(require("node:os").tmpdir(), "rescuenet-dashboard-review");
fs.mkdirSync(output, {recursive: true});
const child = spawn("python", [path.join(__dirname, "dashboard_smoke_server.py"), String(port)], {cwd: root, windowsHide: true, stdio: ["ignore","pipe","pipe"]});
let serverLog = "";
child.stdout.on("data", chunk => { serverLog += chunk; });
child.stderr.on("data", chunk => { serverLog += chunk; });

async function start() {
  for (let index = 0; index < 80; index++) {
    if (child.exitCode != null) throw new Error(serverLog);
    try { const response = await fetch(base); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Isolated fixture server did not start: " + serverLog);
}
async function checkMeshGeometry(page) {
  try { await page.waitForFunction(() => {
    const paths = Array.from(document.querySelectorAll("#mesh-links path"));
    const gateway = document.getElementById("mesh-gateway-device").getBoundingClientRect();
    return paths.length > 0 && paths.every(path => {
      if (!path.getAttribute("d")) return false;
      const button = Array.from(document.querySelectorAll("#topology-nodes button"))
        .find(node => node.dataset.selectNode === path.getAttribute("data-mesh-link"));
      if (!button) return false;
      const box = button.getBoundingClientRect(), matrix = path.getScreenCTM();
      const start = path.getPointAtLength(0).matrixTransform(matrix);
      const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
      return Math.abs(start.x - (gateway.left + gateway.width / 2)) < 1.5 && Math.abs(start.y - gateway.bottom) < 1.5
        && Math.abs(end.x - (box.left + box.width / 2)) < 1.5 && Math.abs(end.y - box.top) < 1.5;
    });
  }, null, {timeout:5000}); } catch (error) {
    console.error("Mesh geometry diagnostic:", await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height}; };
      const point = p => ({x:p.x, y:p.y});
      const canvas = document.getElementById("mesh-topology"), svg = document.getElementById("mesh-links");
      return {view:document.getElementById("view-nodes").className, canvas:rect(canvas),
        svg:rect(svg), viewBox:svg.getAttribute("viewBox"), canvasStyle:{padding:getComputedStyle(canvas).padding, transform:getComputedStyle(canvas).transform},
        gateway:rect(document.getElementById("mesh-gateway-device")),
        links:Array.from(document.querySelectorAll("#mesh-links path")).map(path => ({d:path.getAttribute("d"),
          start:point(path.getPointAtLength(0).matrixTransform(path.getScreenCTM())),
          end:point(path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM())),
          card:rect(document.querySelector(`[data-select-node="${path.getAttribute("data-mesh-link")}"]`))}))};
    }).then(result => JSON.stringify(result)));
    throw error;
  }
}
let browser;
(async () => {
  await start();
  browser = await chromium.launch({headless: true, executablePath: process.env.RESCUENET_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe"});
  const context = await browser.newContext({viewport: {width: 1600,height: 1000}, reducedMotion: "reduce"});
  const page = await context.newPage(), errors = [], failedAssets = [], tileResponses = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/static/") && response.status() >= 400) failedAssets.push(response.url());
    if (response.url().includes("tile.openstreetmap.org") && response.status() === 200) tileResponses.push(response.url());
  });
  // Spy on real Leaflet instances. Original constructors, tile source and behavior are unchanged.
  await page.route("**/vendor/leaflet-1.9.4/leaflet.js", async route => {
    const response = await route.fetch(), body = await response.text();
    await route.fulfill({response, body: body + "\nwindow.__testMaps=[]; const originalMap=L.map; L.map=(...args)=>{const map=originalMap(...args);window.__testMaps.push(map);return map;};"});
  });
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("stat-total").textContent === "37");
  await page.waitForTimeout(2500);
  assert.equal(await page.locator("#reports-table tbody tr").count(), 15);
  assert.equal(await page.evaluate(() => window.L.version), "1.9.4");
  await page.screenshot({path: path.join(output,"dashboard-desktop.png"), fullPage:true});
  console.log("PASS dashboard and all local assets loaded");

  await page.locator('[data-view="reports"]').click();
  const firstId = await page.locator("#reports-table tbody tr").first().getAttribute("data-select-report");
  await page.getByRole("button",{name:"Next page",exact:true}).click();
  const secondId = await page.locator("#reports-table tbody tr").first().getAttribute("data-select-report");
  assert.notEqual(firstId, secondId);
  await page.locator("#condition-filter").selectOption("KRITIS");
  await page.waitForFunction(() => document.getElementById("report-range").textContent.startsWith("Showing 1"));
  await page.locator("#reports-table tbody tr").first().click();
  await page.locator("#selected-report [data-report-id]").click();
  await page.waitForSelector("#report-modal:not([hidden]) #modal-status");
  await page.locator("#modal-status").selectOption("DITANGANI");
  await page.locator("#save-status").click();
  await page.waitForSelector("#report-modal[hidden]", {state:"attached"});
  await page.waitForFunction(() => document.getElementById("selected-report").textContent.includes("DITANGANI"));
  await page.locator("#report-search").fill("no-such-report");
  assert.equal(await page.locator("#reports-table tbody tr").count(), 0);
  await page.locator("#clear-filters").click();
  await page.locator('#reports-table tbody tr').first().focus();
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-select-report")), true, "Unchanged poll must preserve keyboard focus");
  await page.locator('#reports-table th[data-sort="received_at"] button').click();
  assert.equal(await page.locator('#reports-table th[data-sort="received_at"]').getAttribute("aria-sort"), "ascending");
  await page.locator("#report-sort").selectOption("snr");
  await page.locator("#reports-mobile-sos [data-select-mobile]").first().click();
  await page.waitForFunction(() => document.getElementById("selected-report").textContent.includes("PWA SOS"));
  assert.match(await page.locator("#selected-report").innerText(), /Acceptance time is not supplied/);
  assert.match(await page.locator("#selected-report").innerText(), /Not provided for PWA requests/);
  await page.screenshot({path:path.join(output,"reports-desktop.png"),fullPage:true});
  console.log("PASS pagination, filters, sorting, detail selection and actual status PATCH");

  await page.locator('[data-view="nodes"]').click();
  await page.locator('#topology-nodes [data-select-node="2"]').click();
  assert.match(await page.locator("#node-detail-grid").innerText(), /Field Node 2/);
  assert.match(await page.locator("#node-detail-grid").innerText(), /Online/);
  assert.match(await page.locator('#topology-nodes [data-select-node="3"]').innerText(), /Unknown/);
  await checkMeshGeometry(page);
  assert.equal(await page.locator("#mesh-links .mesh-link--online").count(), 1);
  assert.equal(await page.locator("#mesh-links .mesh-link--stale").count(), 1);
  assert.equal(await page.locator("#mesh-links .mesh-link--unknown").count(), 1);
  assert.match(await page.locator("#mesh-animation-note").innerText(), /not packet path/);
  assert.equal(await page.locator(".mesh-mountains").evaluate(el => getComputedStyle(el).pointerEvents), "none");
  assert.equal(await page.locator("#mesh-links").evaluate(el => getComputedStyle(el).pointerEvents), "none");
  for (const selector of [".mesh-link--online", ".mesh-link--stale", ".mesh-link--unknown", ".online .mesh-halo"]) {
    assert.equal(await page.locator(`#mesh-topology ${selector}`).first().evaluate(el => getComputedStyle(el).animationName), "none");
  }
  await page.emulateMedia({reducedMotion:"no-preference"});
  assert.equal(await page.locator(".mesh-link--online").evaluate(el => getComputedStyle(el).animationName), "mesh-link-flow");
  assert.equal(await page.locator(".mesh-link--stale").evaluate(el => getComputedStyle(el).animationName), "mesh-link-stale");
  assert.equal(await page.locator(".mesh-link--unknown").evaluate(el => el.getAnimations().length), 0);
  const dashBefore = await page.locator(".mesh-link--online").evaluate(el => getComputedStyle(el).strokeDashoffset);
  await page.waitForTimeout(180);
  assert.notEqual(await page.locator(".mesh-link--online").evaluate(el => getComputedStyle(el).strokeDashoffset), dashBefore);
  await page.locator('#topology-nodes [data-select-node="3"]').focus();
  await page.keyboard.press("Enter");
  assert.match(await page.locator("#node-detail-grid").innerText(), /Field Node 3/);
  await page.locator('#topology-nodes [data-select-node="2"]').focus();
  await page.keyboard.press("Space");
  assert.match(await page.locator("#node-detail-grid").innerText(), /Field Node 2/);
  await page.evaluate(() => {
    window.__keptMeshCard = document.querySelector('#topology-nodes [data-select-node="2"]');
    window.__keptMeshPath = document.querySelector('#mesh-links [data-mesh-link="2"]');
    window.__keptMeshAnimation = window.__keptMeshPath.getAnimations()[0];
  });
  const refreshedNodes = page.waitForResponse(response => new URL(response.url()).pathname === "/api/nodes");
  await page.evaluate(() => document.getElementById("refresh-button").click());
  await refreshedNodes;
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.activeElement === window.__keptMeshCard), true);
  assert.equal(await page.evaluate(() => document.querySelector('#mesh-links [data-mesh-link="2"]') === window.__keptMeshPath), true);
  assert.equal(await page.evaluate(() => window.__keptMeshPath.getAnimations()[0] === window.__keptMeshAnimation), true);
  await page.screenshot({path:path.join(output,"nodes-desktop.png"),fullPage:true});
  await page.emulateMedia({reducedMotion:"reduce"});
  console.log("PASS mesh status animations, static unknown, reduced motion, keyboard, keyed refresh and aligned SVG links");
  await page.locator('#node-roster [data-select-node="1"]').click();
  assert.match(await page.locator("#node-detail-grid").innerText(), /Field Node 1/);
  assert.match(await page.locator("#node-detail-grid").innerText(), /Device stale/);
  await page.locator('#topology-nodes [data-select-node="2"]').click();
  await page.locator('#node-detail-grid [data-map-position]').click();
  assert.equal(await page.locator("#view-map").evaluate(el => el.classList.contains("active")), true);
  assert.match(await page.locator("#selected-map-position").innerText(), /Field Node 2/);
  await page.locator('[data-view="nodes"]').click();
  await checkMeshGeometry(page);
  await page.locator('[data-node-reports="2"]').click();
  assert.equal(await page.locator("#node-filter").inputValue(), "2");
  console.log("PASS actual online/stale/unknown nodes, roster and report navigation");

  await page.locator('[data-view="map"]').click();
  await page.waitForSelector("#full-map .leaflet-marker-icon");
  await page.locator('#full-map .leaflet-marker-icon').first().click();
  await page.waitForSelector("#full-map .leaflet-popup-content");
  assert.match(await page.locator("#selected-map-position").innerText(), /Field Node/);
  const zoomBefore = await page.evaluate(() => window.__testMaps.find(m => m.getContainer().id === "full-map").getZoom());
  await page.locator("#full-map .leaflet-control-zoom-in").click();
  await page.waitForFunction(zoom => window.__testMaps.find(m => m.getContainer().id === "full-map").getZoom() > zoom, zoomBefore);
  await page.locator('#view-map [data-map-filter="mobile_user"]').click();
  assert.equal(await page.locator("#full-map .leaflet-marker-icon").count(), 1);
  await page.locator('#view-map [data-map-filter="critical"]').click();
  assert.ok(await page.locator("#full-map .leaflet-marker-icon").count() >= 1);
  await page.locator('#view-map [data-map-filter="all"]').click();
  await page.locator('[data-map-fit="full-map"]').click();
  assert.equal(await page.locator("#full-map .leaflet-marker-icon").count(), 5);
  assert.equal(await page.evaluate(() => window.__testMaps.find(m => m.getContainer().id === "full-map").options.zoomControl), true);
  await page.screenshot({path:path.join(output,"map-desktop.png"),fullPage:true});
  console.log("PASS real Leaflet zoom, popup, marker selection, filters and fit markers");

  await page.locator('[data-view="dashboard"]').click();
  const started = Date.now();
  await page.request.post(base + "/__test__/new-sos");
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("baru"), {timeout:6000});
  await page.waitForFunction(() => document.getElementById("stat-total").textContent === "38");
  await page.waitForFunction(() => document.getElementById("dashboard-mobile-sos").textContent.includes("new-brow"));
  await page.locator('[data-view="map"]').click();
  await page.waitForFunction(() => document.getElementById("map-report-list").textContent.includes("-6.20100"));
  console.log(`PASS committed database event → toast/table/map refresh in ${Date.now()-started}ms (local test, no radio)`);

  await page.locator('[data-view="system"]').click();
  await page.waitForSelector("#metric-grid .metric-card");
  await page.screenshot({path:path.join(output,"system-desktop.png"),fullPage:true});
  for (const width of [768,375]) {
    await page.setViewportSize({width,height:900});
    for (const view of ["dashboard","reports","map","nodes","system"]) {
      if (width <= 760) await page.locator("#mobile-menu").click();
      await page.locator(`[data-view="${view}"]`).click();
      await page.waitForTimeout(100);
      const dimensions = await page.evaluate(() => ({viewport:innerWidth, page:document.documentElement.scrollWidth}));
      assert.ok(dimensions.page <= dimensions.viewport + 1, `${view} overflows at ${width}: ${JSON.stringify(dimensions)}`);
      if (view === "nodes") {
        await checkMeshGeometry(page);
        if (width === 375) await page.screenshot({path:path.join(output,"nodes-mobile.png"),fullPage:true});
      }
    }
  }
  await page.locator("#mobile-menu").click();
  await page.locator('[data-view="dashboard"]').click();
  await page.screenshot({path:path.join(output,"dashboard-mobile.png"),fullPage:true});
  await page.setViewportSize({width:1600,height:1000});
  await page.route("**/api/**", route => route.abort("failed"));
  await page.waitForFunction(() => document.getElementById("connection-state").textContent.includes("Unreachable"), {timeout:8000});
  assert.equal(await page.locator("#stat-total").innerText(), "38");
  assert.match(await page.locator("#refresh-warning").innerText(), /may be out of date/);
  console.log("PASS tablet/mobile navigation, no viewport overflow, disconnected state retains last data");

  const failurePage = await context.newPage();
  failurePage.on("pageerror", error => errors.push(error.message));
  await failurePage.route("**/api/**", route => route.abort("failed"));
  await failurePage.goto(base);
  await failurePage.waitForSelector("#reports-table .error-state", {state:"attached"});
  await failurePage.waitForFunction(() => document.getElementById("connection-state").textContent.includes("Unreachable"));
  await failurePage.screenshot({path:path.join(output,"dashboard-api-failure.png"),fullPage:true});
  assert.equal(await failurePage.locator("#stat-total").innerText(), "—");
  await failurePage.locator('[data-view="nodes"]').click();
  assert.equal(await failurePage.locator("#mesh-links path").count(), 0);
  assert.match(await failurePage.locator("#topology-nodes").innerText(), /Node activity unavailable/);

  // Empty and partial-failure presentation; only these explicit test feeds are mocked.
  const emptyPage = await context.newPage();
  emptyPage.on("pageerror", error => errors.push(error.message));
  await emptyPage.route("**/api/reports?limit=1000", route => route.fulfill({json:[]}));
  await emptyPage.route("**/api/mobile/events?limit=100", route => route.fulfill({json:[]}));
  await emptyPage.route("**/api/nodes", route => route.fulfill({json:[]}));
  await emptyPage.route("**/api/map/positions", route => route.fulfill({json:{positions:[], links:[]}}));
  await emptyPage.goto(base);
  await emptyPage.waitForSelector("#dashboard-mobile-sos .empty-state", {state:"attached"});
  await emptyPage.waitForSelector("#dashboard-nodes .empty-state", {state:"attached"});
  assert.match(await emptyPage.locator("#dashboard-nodes").innerText(), /No Field Nodes/);
  assert.match(await emptyPage.locator("#reports-table").innerText(), /No reports/);
  await emptyPage.locator('[data-view="nodes"]').click();
  assert.equal(await emptyPage.locator("#mesh-links path").count(), 0);
  assert.match(await emptyPage.locator("#topology-nodes").innerText(), /No observed Field Nodes/);
  await emptyPage.locator('[data-view="map"]').click();
  await emptyPage.waitForSelector("#full-map .leaflet-control-zoom-in");
  assert.equal(await emptyPage.locator("#full-map .leaflet-marker-icon").count(), 0);
  await emptyPage.screenshot({path:path.join(output,"map-empty.png"),fullPage:true});

  const partialPage = await context.newPage();
  partialPage.on("pageerror", error => errors.push(error.message));
  await partialPage.route("**/api/mobile/events?limit=100", route => route.abort("failed"));
  await partialPage.goto(base);
  await partialPage.waitForSelector("#dashboard-mobile-sos tbody tr");
  await partialPage.waitForSelector("#refresh-warning:not([hidden])");
  assert.match(await partialPage.locator("#refresh-warning").innerText(), /PWA SOS/);
  assert.match(await partialPage.locator("#reports-mobile-sos").innerText(), /temporarily unavailable/);
  console.log("PASS empty feeds, unchanged-poll keyboard focus, partial PWA failure retains portal SOS");

  // Explicit test-only node feeds cover changes in status/count; production still uses the existing API.
  const meshPage = await context.newPage();
  meshPage.on("pageerror", error => errors.push(error.message));
  const fixtureNodes = await (await meshPage.request.get(base + "/api/nodes")).json();
  let nodeFeed = fixtureNodes;
  const nodeRequestTimes = [];
  await meshPage.route("**/api/nodes", route => {
    nodeRequestTimes.push(Date.now());
    return route.fulfill({json:nodeFeed});
  });
  await meshPage.goto(base + "#nodes");
  await checkMeshGeometry(meshPage);
  await meshPage.locator('#topology-nodes [data-select-node="2"]').click();
  nodeFeed = fixtureNodes.map(node => node.node_id === 2 ? {...node, device_status:"stale", heartbeat_seconds_ago:900} : node);
  await meshPage.locator("#refresh-button").click();
  await meshPage.waitForSelector('#mesh-links [data-mesh-link="2"].mesh-link--stale', {state:"attached"});
  assert.equal(await meshPage.locator('#topology-nodes [data-select-node="2"]').getAttribute("aria-pressed"), "true");
  assert.match(await meshPage.locator('#topology-nodes [data-select-node="2"]').innerText(), /Stale/);
  nodeFeed = [];
  await meshPage.locator("#refresh-button").click();
  await meshPage.waitForSelector("#topology-nodes .empty-state");
  assert.equal(await meshPage.locator("#mesh-links path").count(), 0);
  nodeFeed = [7, 12, 27, 41, 99].map((id, index) => ({...fixtureNodes[index % fixtureNodes.length], node_id:id}));
  await meshPage.locator("#refresh-button").click();
  await meshPage.waitForSelector('#topology-nodes [data-select-node="99"]');
  assert.equal(await meshPage.locator("#mesh-links path").count(), 5);
  assert.match(await meshPage.locator("#node-detail-grid").innerText(), /Field Node 7/);
  await meshPage.setViewportSize({width:320,height:900});
  await checkMeshGeometry(meshPage);
  assert.ok(await meshPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await meshPage.screenshot({path:path.join(output,"nodes-wrapped-mobile.png"),fullPage:true});
  // Animation frames must not add API polling. Inspect within less than the existing 5-second interval.
  const probeStart = Date.now(), requestsBefore = nodeRequestTimes.length;
  await meshPage.emulateMedia({reducedMotion:"no-preference"});
  await meshPage.waitForTimeout(650);
  assert.ok(nodeRequestTimes.length - requestsBefore <= 1, "Mesh animation must not fetch telemetry per frame");
  const duringProbe = nodeRequestTimes.filter(time => time >= probeStart);
  assert.ok(duringProbe.length <= 1, "Existing polling must not be accelerated");
  console.log("PASS live status transitions, empty recovery, five arbitrary node IDs, wrapped 320px layout and no animation polling");
  assert.equal(failedAssets.length, 0, failedAssets.join("\n"));
  assert.deepEqual(errors, [], errors.join("\n"));
  console.log(`PASS API failure without fake success; real tile responses: ${tileResponses.length}; no runtime errors or missing static assets`);
  console.log("Screenshots: " + output);
})().catch(error => {
  console.error(error.stack || error);
  console.error(serverLog.slice(-3500));
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  child.kill();
});
