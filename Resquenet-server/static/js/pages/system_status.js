(function () {
  "use strict";
  const ui = window.RescueNetUI;
  const {byId, h, operationalBadge, formatUptime} = ui;
  function serviceCard(icon, title, status) {
    return `<article class="service-card"><span class="service-card-icon"><svg><use href="#${h(icon)}"/></svg></span><strong>${h(title)}</strong>${operationalBadge(status)}</article>`;
  }

  function renderSystem(state) {
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
      const cpu = metrics.cpu_percent != null && Number.isFinite(Number(metrics.cpu_percent)) ? Number(metrics.cpu_percent) : null;
      const memory = metrics.memory_percent != null && Number.isFinite(Number(metrics.memory_percent)) ? Number(metrics.memory_percent) : null;
      const disk = metrics.disk_percent != null && Number.isFinite(Number(metrics.disk_percent)) ? Number(metrics.disk_percent) : null;
      byId("metric-grid").innerHTML = [
        metric("CPU Usage", cpu === null ? "Not available" : `${cpu.toFixed(1)}%`, "%", cpu),
        metric("RAM Usage", memory === null ? "Not available" : `${memory.toFixed(1)}%`, "%", memory),
        metric("Disk Usage", disk === null ? "Not available" : `${disk.toFixed(1)}%`, "%", disk),
        metric("CPU Temperature", metrics.temperature_c == null ? "Not available" : `${Number(metrics.temperature_c).toFixed(1)}°C`, "", null),
        metric("System Uptime", h(formatUptime(metrics.uptime_seconds)), "", null),
      ].join("");
    }
  }


  ui.pages.system = { render: renderSystem };
})();
