(function () {
  "use strict";
  const ui = window.RescueNetUI;
  const {byId, all, h, display, numberDisplay, relativeTime, formatTime, badge, icon} = ui;
  ui.pages.map = { create({state, mapConfig, switchView}) {
    const liveMaps = new Map();
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
      rows.push(["GPS fix time", formatTime(position.fix_timestamp || position.updated_at)]);
      rows.push(["Server received", formatTime(position.received_at)]);
      rows.push(["User key", display(position.user_key)]);
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
        empty.innerHTML = "<strong>Map library unavailable</strong>Check that the local Leaflet assets were copied, then reload this page.";
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
      marker.on("click", () => { state.selectedMapPositionId = position.id; renderSelectedPosition(); });
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
    renderSelectedPosition();
    all("[data-map-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.mapFilter === state.mapFilter)));
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


  function focusMapPosition(positionId) {
    state.selectedMapPositionId = positionId;
    renderSelectedPosition();
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


  function renderSelectedPosition() {
    if (!state.mapSnapshot) return;
    const positions = (state.mapSnapshot.positions || []).filter(mapPositionVisible);
    let position = positions.find(p => p.id === state.selectedMapPositionId);
    if (!position) position = positions.find(p => p.critical) || positions[0];
    const target = byId("selected-map-position");
    if (!position) { target.innerHTML = '<div class="empty-state">No location in this filter. Choose another filter or wait for GPS data.</div>'; return; }
    state.selectedMapPositionId = position.id;
    const mobileEvent = (state.mobileSos || []).find(e => e.user_key === position.user_key && Number(e.received_at) === Number(position.received_at));
    const detailAction = position.report_id ? `<button class="button primary" data-report-id="${h(position.report_id)}">View report</button>`
      : mobileEvent ? `<button class="button primary" data-select-mobile="${h(mobileEvent.request_key)}">View SOS</button>` : "";
    target.innerHTML = `<div class="panel-header"><div><h2>${position.critical ? "Selected SOS location" : "Selected location"}</h2><p>${h(position.label)}</p></div>${position.critical ? badge("Critical", "danger") : ""}</div>
      <div class="selected-position"><span class="position-emblem ${position.critical ? "danger" : position.type}">${icon(position.critical ? "i-warning" : "i-pin")}</span><div><strong>${h(position.label)}</strong><small>${position.type === "gateway" ? "Configured Gateway location" : position.type === "mobile_user" ? "Mobile GPS position" : "Field Node report position"}</small></div></div>
      <dl class="incident-fields"><div><dt>Latitude</dt><dd>${numberDisplay(position.lat,6)}</dd></div><div><dt>Longitude</dt><dd>${numberDisplay(position.lon,6)}</dd></div><div><dt>GPS updated</dt><dd>${h(relativeTime(position.seconds_ago))}</dd></div><div><dt>Freshness</dt><dd>${badge(position.freshness, position.freshness === "recent" ? "success" : "warning")}</dd></div></dl>
      ${position.type === "gateway" ? '<p class="panel-footnote">This marker is configured on the server; it is not a live GPS observation.</p>' : `<p class="position-receipt">${badge("Received by server", "success")}<span>${h(formatTime(position.received_at || position.updated_at))}</span></p>`}
      <div class="detail-actions">${detailAction}<button class="button secondary" data-map-position="${h(position.id)}">Center on map</button></div>`;
  }

    return {liveMaps, renderMaps, renderMapFailure, fitMapMarkers, focusMapPosition};
  }};
})();
