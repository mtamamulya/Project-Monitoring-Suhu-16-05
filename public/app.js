/**
 * app.js — ClimateOS Dashboard v2
 * Modular vanilla JS — multi-page navigation, history chart, analysis,
 * floating AI chat bubble, PDF export, CSV export, Web Speech API.
 */

'use strict';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  API_BASE_URL: 'https://climateos-backend.onrender.com',
  POLL_INTERVAL_MS: 30_000,
  WEATHER_INTERVAL_MS: 600_000,
  STATS_INTERVAL_MS: 120_000,
  GAUGE_TOTAL_ARC_LENGTH: 188,
  TEMP_MAX: 50,
  TEMP_MIN: 0,
};

// ── STATE ─────────────────────────────────────────────────────────────────────
const State = {
  latestTemp: null,
  latestHum: null,
  outdoor: null,
  chartRange: 'live',
  historyRange: '3h',
  chartData: { labels: [], temps: [], hums: [] },
  chatHistory: [],
  isMicActive: false,
  recognition: null,
  currentPage: 'dashboard',
  historyData: [],
};

// ── DOM HELPERS ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };

// ── NAVIGATION ────────────────────────────────────────────────────────────────
function navigateTo(page) {
  if (State.currentPage === page) return;
  State.currentPage = page;

  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // Show target
  const pageEl = $('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  // Update sidebar nav items
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // Update bottom nav items
  document.querySelectorAll('.bnav-item[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // Update page title
  const titles = { dashboard: 'Dashboard', history: 'History', analysis: 'Analysis' };
  setText('page-title', titles[page] || page);

  // Page-specific init
  if (page === 'history') {
    fetchHistory(State.historyRange, true);
  }
  if (page === 'analysis') {
    updateAnalysisPage();
  }
}

function attachNavListeners() {
  document.querySelectorAll('[data-page]').forEach(btn => {
    if (btn.id === 'btn-theme' || btn.id === 'sidebar-theme-btn') return;
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
}

// ── GAUGE RENDERER ────────────────────────────────────────────────────────────
function updateGauge(arcId, valueId, value, min, max) {
  const arcEl = $(arcId);
  const valEl = $(valueId);
  if (!arcEl || !valEl) return;
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const offset = CONFIG.GAUGE_TOTAL_ARC_LENGTH * (1 - ratio);
  arcEl.style.strokeDashoffset = offset;
  valEl.textContent = value.toFixed(1);
}

// ── STATUS BADGES ─────────────────────────────────────────────────────────────
function getTempBadgeConfig(temp) {
  if (temp < 20) return { label: 'Cold', classes: 'badge', style: 'background:var(--sky-soft);color:var(--sky);border-color:var(--sky-soft);' };
  if (temp <= 26) return { label: 'Normal', classes: 'badge', style: 'background:var(--emerald-soft);color:var(--emerald);border-color:var(--emerald-soft);' };
  if (temp < 32) return { label: 'Warm', classes: 'badge', style: 'background:var(--amber-soft);color:var(--amber);border-color:var(--amber-soft);' };
  return { label: '⚠ Hot', classes: 'badge badge-critical', style: '' };
}

function getHumBadgeConfig(hum) {
  if (hum < 40) return { label: 'Dry', style: 'background:var(--amber-soft);color:var(--amber);border-color:var(--amber-soft);' };
  if (hum <= 60) return { label: 'Ideal', style: 'background:var(--emerald-soft);color:var(--emerald);border-color:var(--emerald-soft);' };
  if (hum <= 75) return { label: 'Humid', style: 'background:var(--sky-soft);color:var(--sky);border-color:var(--sky-soft);' };
  return { label: 'Muggy', style: 'background:var(--teal-soft);color:var(--teal);border-color:var(--teal-soft);' };
}

function applyBadge(id, config) {
  const el = $(id);
  if (!el) return;
  el.textContent = config.label;
  if (config.classes) el.className = config.classes;
  if (config.style !== undefined) el.setAttribute('style', config.style);
}

// ── COMPARE WIDGET ────────────────────────────────────────────────────────────
function updateCompareWidget(indoorTemp, indoorHum, outdoor) {
  setText('compare-indoor-temp', `${indoorTemp.toFixed(1)}°`);
  setText('compare-indoor-hum', `${indoorHum.toFixed(1)}% RH`);

  if (outdoor && outdoor.temperature != null) {
    const delta = indoorTemp - outdoor.temperature;
    const sign = delta >= 0 ? '+' : '';

    setText('compare-outdoor-temp', `${outdoor.temperature.toFixed(1)}°`);
    setText('compare-outdoor-desc', outdoor.description || '—');
    setText('delta-value', `${sign}${delta.toFixed(1)}°C`);
    setText('outdoor-feels', outdoor.feels_like != null ? `${outdoor.feels_like.toFixed(1)}°C` : '—');
    setText('outdoor-wind', outdoor.wind_speed != null ? outdoor.wind_speed.toFixed(1) : '—');
    setText('outdoor-hum', outdoor.humidity != null ? outdoor.humidity : '—');

    const deltaEl = $('delta-value');
    const arrowEl = $('delta-arrow');
    if (deltaEl && arrowEl) {
      const abs = Math.abs(delta);
      if (abs < 0.5) {
        deltaEl.className = 'num-md tabular delta-eq';
        arrowEl.textContent = '⇄'; arrowEl.className = 'delta-eq'; arrowEl.style.fontSize = '22px';
      } else if (delta > 0) {
        deltaEl.className = 'num-md tabular delta-up';
        arrowEl.textContent = '↑'; arrowEl.className = 'delta-up'; arrowEl.style.fontSize = '22px';
      } else {
        deltaEl.className = 'num-md tabular delta-down';
        arrowEl.textContent = '↓'; arrowEl.className = 'delta-down'; arrowEl.style.fontSize = '22px';
      }
    }
  }
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function updateStatsCards(stats) {
  setText('stat-min', stats.temp_min != null ? `${stats.temp_min}°C` : '—');
  setText('stat-max', stats.temp_max != null ? `${stats.temp_max}°C` : '—');
  setText('stat-avg', stats.temp_avg != null ? `${stats.temp_avg}°C` : '—');
  setText('stat-count', stats.count != null ? stats.count.toLocaleString() : '—');
}

// ── MAIN CHART ────────────────────────────────────────────────────────────────
let climateChart = null;

function initMainChart() {
  const canvas = $('climate-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const tempGrad = ctx.createLinearGradient(0, 0, 0, 240);
  tempGrad.addColorStop(0, 'rgba(251,146,60,0.22)');
  tempGrad.addColorStop(1, 'rgba(251,146,60,0)');

  const humGrad = ctx.createLinearGradient(0, 0, 0, 240);
  humGrad.addColorStop(0, 'rgba(56,189,248,0.18)');
  humGrad.addColorStop(1, 'rgba(56,189,248,0)');

  climateChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Temperature (°C)', data: [], yAxisID: 'yTemp',
          borderColor: '#fb923c', backgroundColor: tempGrad, borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: true,
        },
        {
          label: 'Humidity (%)', data: [], yAxisID: 'yHum',
          borderColor: '#38bdf8', backgroundColor: humGrad, borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: true,
        },
      ],
    },
    options: _chartOptions(),
  });
}

function _chartOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'var(--card, #18181b)',
        borderColor: 'var(--hair, #3f3f46)', borderWidth: 1,
        titleColor: '#a1a1aa', bodyColor: '#f4f4f5',
        titleFont: { family: 'JetBrains Mono', size: 11 },
        bodyFont: { family: 'JetBrains Mono', size: 12 },
        padding: 10,
        callbacks: {
          label: (ctx) => {
            const unit = ctx.datasetIndex === 0 ? '°C' : '%';
            return ` ${ctx.dataset.label.split(' ')[0]}: ${ctx.parsed.y.toFixed(1)}${unit}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
        grid: { color: 'rgba(127,127,127,0.12)', drawBorder: false },
        ticks: { color: '#888', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0, maxTicksLimit: 7 },
        border: { display: false },
      },
      yTemp: {
        position: 'left',
        grid: { color: 'rgba(127,127,127,0.12)', drawBorder: false },
        ticks: { color: '#fb923c', font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => `${v}°` },
        border: { display: false },
      },
      yHum: {
        position: 'right',
        grid: { display: false },
        ticks: { color: '#38bdf8', font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => `${v}%` },
        border: { display: false },
        min: 0, max: 100,
      },
    },
  };
}

function updateMainChart(records) {
  if (!climateChart || !records.length) return;
  climateChart.data.labels = records.map((r) => new Date(r.timestamp));
  climateChart.data.datasets[0].data = records.map((r) => r.temperature);
  climateChart.data.datasets[1].data = records.map((r) => r.humidity);
  climateChart.update('active');
  State.chartData = {
    labels: records.map((r) => r.timestamp),
    temps: records.map((r) => r.temperature),
    hums: records.map((r) => r.humidity),
  };
}

// ── HISTORY CHART ─────────────────────────────────────────────────────────────
let historyChart = null;

function initHistoryChart() {
  const canvas = $('history-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Temperature (°C)', data: [], yAxisID: 'yTemp',
          borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.12)',
          borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: true,
        },
        {
          label: 'Humidity (%)', data: [], yAxisID: 'yHum',
          borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.10)',
          borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: true,
        },
      ],
    },
    options: { ..._chartOptions(), plugins: { ..._chartOptions().plugins } },
  });
}

function updateHistoryChart(records) {
  if (!historyChart) initHistoryChart();
  if (!historyChart || !records.length) return;
  historyChart.data.labels = records.map((r) => new Date(r.timestamp));
  historyChart.data.datasets[0].data = records.map((r) => r.temperature);
  historyChart.data.datasets[1].data = records.map((r) => r.humidity);
  historyChart.update('active');
}

// ── ANALYSIS CHART ────────────────────────────────────────────────────────────
let analysisChart = null;

function initAnalysisChart() {
  const canvas = $('analysis-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  analysisChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Indoor °C', data: [], yAxisID: 'y',
          borderColor: '#fb923c', borderWidth: 2,
          pointRadius: 0, tension: 0.4, fill: false,
        },
        {
          label: 'Outdoor °C', data: [], yAxisID: 'y',
          borderColor: '#38bdf8', borderWidth: 2,
          borderDash: [4, 3],
          pointRadius: 0, tension: 0.4, fill: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#888', font: { family: 'JetBrains Mono', size: 11 } } },
        tooltip: {
          backgroundColor: '#18181b', borderColor: '#3f3f46', borderWidth: 1,
          titleColor: '#a1a1aa', bodyColor: '#f4f4f5',
          titleFont: { family: 'JetBrains Mono', size: 11 },
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}°C` },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'HH:mm', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
          grid: { color: 'rgba(127,127,127,0.10)', drawBorder: false },
          ticks: { color: '#888', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 6 },
          border: { display: false },
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(127,127,127,0.10)', drawBorder: false },
          ticks: { color: '#888', font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => `${v}°` },
          border: { display: false },
        },
      },
    },
  });
}

// ── HISTORY TABLE ─────────────────────────────────────────────────────────────
function updateHistoryTable(records) {
  const tbody = $('history-tbody');
  if (!tbody) return;

  setText('hist-table-count', `${records.length} records`);

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--muted-2);font-size:13px;">No data for this time range.</td></tr>';
    return;
  }

  const rows = records.slice().reverse().map((r, i) => {
    const ts = new Date(r.timestamp).toLocaleString('id-ID', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const temp = r.temperature;
    let statusStyle = 'background:var(--emerald-soft);color:var(--emerald);';
    let statusLabel = 'Normal';
    if (temp < 20) { statusStyle = 'background:var(--sky-soft);color:var(--sky);'; statusLabel = 'Cold'; }
    else if (temp >= 32) { statusStyle = 'background:var(--crit-soft);color:var(--crit);'; statusLabel = 'Hot'; }
    else if (temp >= 27) { statusStyle = 'background:var(--amber-soft);color:var(--amber);'; statusLabel = 'Warm'; }

    const bg = i % 2 === 0 ? 'background: transparent;' : 'background: var(--bg-2);';
    return `<tr style="${bg}">
      <td style="padding:9px 16px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hair);">${ts}</td>
      <td style="padding:9px 16px;text-align:right;font-weight:600;font-size:13px;color:var(--coral);border-bottom:1px solid var(--hair);">${temp.toFixed(1)}</td>
      <td style="padding:9px 16px;text-align:right;font-weight:600;font-size:13px;color:var(--sky);border-bottom:1px solid var(--hair);">${r.humidity.toFixed(1)}</td>
      <td style="padding:9px 16px;border-bottom:1px solid var(--hair);">
        <span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:600;letter-spacing:0.03em;${statusStyle}">${statusLabel}</span>
      </td>
    </tr>`;
  }).join('');

  tbody.innerHTML = rows;
}

// ── HISTORY SUMMARY ───────────────────────────────────────────────────────────
function updateHistorySummary(records, range) {
  setText('hist-range-label', range);
  setText('hist-count', records.length.toLocaleString());

  if (records.length) {
    const temps = records.map(r => r.temperature);
    const span = (Math.max(...temps) - Math.min(...temps)).toFixed(1);
    setText('hist-span', `${span}°C`);
  } else {
    setText('hist-span', '—');
  }
}

// ── ANALYSIS PAGE ─────────────────────────────────────────────────────────────
function updateAnalysisPage() {
  const { latestTemp, latestHum, outdoor } = State;

  // Indoor stats
  setText('an-indoor-temp', latestTemp != null ? `${latestTemp.toFixed(1)}°C` : '—');
  setText('an-avg-temp', '—');
  setText('an-min-temp', '—');
  setText('an-max-temp', '—');

  // Fetch fresh stats to populate analysis
  fetch(`${CONFIG.API_BASE_URL}/api/stats`)
    .then(r => r.json())
    .then(data => {
      setText('an-avg-temp', data.temp_avg != null ? `${data.temp_avg}°C` : '—');
      setText('an-min-temp', data.temp_min != null ? `${data.temp_min}°C` : '—');
      setText('an-max-temp', data.temp_max != null ? `${data.temp_max}°C` : '—');
    })
    .catch(() => {});

  // Outdoor
  if (outdoor) {
    setText('an-out-temp', outdoor.temperature != null ? `${outdoor.temperature.toFixed(1)}°C` : '—');
    setText('an-feels', outdoor.feels_like != null ? `${outdoor.feels_like.toFixed(1)}°C` : '—');
    setText('an-out-hum', outdoor.humidity != null ? `${outdoor.humidity}%` : '—');
    setText('an-wind', outdoor.wind_speed != null ? `${outdoor.wind_speed.toFixed(1)} m/s` : '—');
  }

  // Delta
  setText('an-delta-indoor', latestTemp != null ? `${latestTemp.toFixed(1)}°C` : '—');
  setText('an-delta-outdoor', outdoor?.temperature != null ? `${outdoor.temperature.toFixed(1)}°C` : '—');

  if (latestTemp != null && outdoor?.temperature != null) {
    const delta = latestTemp - outdoor.temperature;
    const sign = delta >= 0 ? '+' : '';
    setText('an-delta-result', `${sign}${delta.toFixed(1)}°C`);

    const resultCard = $('an-delta-result-card');
    const resultText = $('an-delta-result');
    if (resultCard && resultText) {
      if (delta > 3) {
        resultCard.style.background = 'var(--coral-soft)';
        resultText.style.color = 'var(--coral)';
      } else if (delta < -3) {
        resultCard.style.background = 'var(--sky-soft)';
        resultText.style.color = 'var(--sky)';
      } else {
        resultCard.style.background = 'var(--emerald-soft)';
        resultText.style.color = 'var(--emerald)';
      }
    }
  }

  // Comfort assessment
  updateComfortAssessment(latestTemp, latestHum, outdoor);

  // Populate analysis chart with history data
  if (!analysisChart) initAnalysisChart();
  if (State.chartData.labels.length && outdoor?.temperature != null) {
    const labels = State.chartData.labels.map(l => new Date(l));
    const indoorTemps = State.chartData.temps;
    const outdoorLine = labels.map(() => outdoor.temperature);
    if (analysisChart) {
      analysisChart.data.labels = labels;
      analysisChart.data.datasets[0].data = indoorTemps;
      analysisChart.data.datasets[1].data = outdoorLine;
      analysisChart.update('active');
    }
  }
}

function updateComfortAssessment(temp, hum, outdoor) {
  // Thermal comfort
  let thermalLabel = '—', thermalNote = '—';
  if (temp != null) {
    if (temp < 18) { thermalLabel = '❄ Cold'; thermalNote = 'Below comfortable range'; }
    else if (temp <= 24) { thermalLabel = '✓ Comfortable'; thermalNote = 'Ideal temperature range'; }
    else if (temp <= 28) { thermalLabel = '○ Acceptable'; thermalNote = 'Slightly warm, tolerable'; }
    else if (temp <= 32) { thermalLabel = '⚠ Warm'; thermalNote = 'Ventilation recommended'; }
    else { thermalLabel = '🔥 Hot'; thermalNote = 'Above comfort threshold'; }
  }
  setText('comfort-thermal', thermalLabel);
  setText('comfort-thermal-note', thermalNote);

  // Humidity
  let humLabel = '—', humNote = '—';
  if (hum != null) {
    if (hum < 30) { humLabel = '○ Too Dry'; humNote = 'May cause skin irritation'; }
    else if (hum <= 50) { humLabel = '✓ Dry-Ideal'; humNote = 'Good range for most people'; }
    else if (hum <= 60) { humLabel = '✓ Ideal'; humNote = 'Optimal comfort zone'; }
    else if (hum <= 70) { humLabel = '⚠ Humid'; humNote = 'Mold risk; ventilate'; }
    else { humLabel = '⚠ Muggy'; humNote = 'High mold & discomfort risk'; }
  }
  setText('comfort-hum', humLabel);
  setText('comfort-hum-note', humNote);

  // Delta
  let deltaLabel = '—', deltaNoteText = '—';
  if (temp != null && outdoor?.temperature != null) {
    const d = temp - outdoor.temperature;
    if (Math.abs(d) < 1) { deltaLabel = '≈ Equal'; deltaNoteText = 'Similar to outdoor'; }
    else if (d > 0) { deltaLabel = `+${d.toFixed(1)}°C warmer`; deltaNoteText = d > 5 ? 'Consider ventilation' : 'Slightly above outdoor'; }
    else { deltaLabel = `${d.toFixed(1)}°C cooler`; deltaNoteText = 'Room is below outdoor temp'; }
  }
  setText('comfort-delta', deltaLabel);
  setText('comfort-delta-note', deltaNoteText);

  // Overall
  let overall = '—', overallNote = '—';
  if (temp != null && hum != null) {
    const good = temp >= 20 && temp <= 28 && hum >= 40 && hum <= 65;
    const critical = temp > 32 || hum > 75;
    if (critical) { overall = '⚠ Needs attention'; overallNote = 'Conditions outside comfort zone'; }
    else if (good) { overall = '✓ Good'; overallNote = 'All metrics within range'; }
    else { overall = '○ Acceptable'; overallNote = 'Minor deviations present'; }
  }
  setText('comfort-overall', overall);
  setText('comfort-overall-note', overallNote);
}

// ── CLOCK ─────────────────────────────────────────────────────────────────────
function startClock() {
  const update = () => {
    const el = $('footer-time');
    if (el) {
      el.textContent = new Date().toLocaleString('en-GB', {
        hour12: false, weekday: 'short', year: 'numeric',
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
  };
  update();
  setInterval(update, 1000);
}

// ── API CALLS ─────────────────────────────────────────────────────────────────
async function fetchLatestTelemetry() {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/latest`);
    if (!res.ok) return;
    const latest = await res.json();
    if (latest?.temperature != null) {
      State.latestTemp = latest.temperature;
      State.latestHum = latest.humidity;
      updateGauge('gauge-temp-arc', 'gauge-temp-value', latest.temperature, CONFIG.TEMP_MIN, CONFIG.TEMP_MAX);
      updateGauge('gauge-hum-arc', 'gauge-hum-value', latest.humidity, 0, 100);
      applyBadge('badge-temp', getTempBadgeConfig(latest.temperature));
      applyBadge('badge-hum', getHumBadgeConfig(latest.humidity));
      if (State.outdoor) updateCompareWidget(latest.temperature, latest.humidity, State.outdoor);
      const el = $('last-updated');
      if (el) el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    }
  } catch (err) {
    console.warn('[Telemetry]', err.message);
  }
}

async function fetchHistory(range, forHistoryPage = false) {
  if (!forHistoryPage) range = State.chartRange;

  // Dashboard needs range mapping; history page uses larger windows
  const apiRange = ['3h', '6h'].includes(range) ? '3h' : range; // API supports: live,1h,3h,12h,24h
  // Remap 3h/6h that backend may not support: use 12h and slice client-side
  const rangeMap = { live: 'live', '1h': '1h', '3h': '3h', '6h': '12h', '12h': '12h', '24h': '24h' };
  const fetchRange = rangeMap[range] || range;

  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/history?range=${fetchRange}`);
    if (!res.ok) return;
    const { data } = await res.json();

    // Client-side filter for 6h
    let filtered = data;
    if (range === '6h') {
      const cutoff = Date.now() - 6 * 3600 * 1000;
      filtered = data.filter(r => new Date(r.timestamp).getTime() >= cutoff);
    }

    if (forHistoryPage) {
      State.historyData = filtered;
      State.historyRange = range;
      updateHistoryChart(filtered);
      updateHistoryTable(filtered);
      updateHistorySummary(filtered, range);
    } else {
      updateMainChart(filtered);
    }
  } catch (err) {
    console.warn('[History]', err.message);
  }
}

async function fetchStats() {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/stats`);
    if (!res.ok) return;
    const data = await res.json();
    updateStatsCards(data);
  } catch (err) {
    console.warn('[Stats]', err.message);
  }
}

async function fetchWeather() {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/weather`);
    if (!res.ok) return;
    const data = await res.json();
    State.outdoor = data;
    if (State.latestTemp !== null) {
      updateCompareWidget(State.latestTemp, State.latestHum, data);
    }
  } catch (err) {
    console.warn('[Weather]', err.message);
  }
}

// ── CHAT (FLOATING BUBBLE) ────────────────────────────────────────────────────
let chatOpen = false;

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = $('chat-panel');
  const fab = $('chat-fab-btn');
  const badge = $('chat-fab-badge');
  if (!panel || !fab) return;

  panel.classList.toggle('open', chatOpen);
  fab.classList.toggle('open', chatOpen);
  if (badge) badge.classList.remove('show');

  if (chatOpen) {
    setTimeout(() => {
      const input = $('chat-input');
      if (input) input.focus();
    }, 300);
  }
}

function appendMessage(role, text) {
  const msgs = $('chat-messages');
  if (!msgs) return;

  const el = document.createElement('div');
  el.className = role === 'user' ? 'chat-user' : 'chat-ai';
  el.innerHTML = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function showTypingIndicator() {
  const id = 'typing-indicator';
  if ($('typing-indicator')) return;
  const msgs = $('chat-messages');
  if (!msgs) return;
  const el = document.createElement('div');
  el.id = id;
  el.className = 'chat-ai';
  el.innerHTML = `<div style="display:flex;align-items:center;gap:5px;"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeTypingIndicator() {
  $('typing-indicator')?.remove();
}

async function sendChatMessage() {
  const input = $('chat-input');
  const sendBtn = $('btn-send');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  if (sendBtn) sendBtn.disabled = true;

  // Open chat panel if closed
  if (!chatOpen) toggleChat();

  appendMessage('user', message);
  showTypingIndicator();

  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    removeTypingIndicator();
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      appendMessage('ai', `❌ ${err.error || 'Something went wrong.'}`);
      return;
    }
    const { reply } = await res.json();
    appendMessage('ai', reply);

    // Show fab badge if panel is closed
    if (!chatOpen) {
      const badge = $('chat-fab-badge');
      if (badge) badge.classList.add('show');
    }
  } catch (err) {
    removeTypingIndicator();
    appendMessage('ai', '❌ Network error. Check your connection.');
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

// ── WEB SPEECH API ────────────────────────────────────────────────────────────
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('btn-mic');
  if (!SpeechRecognition) {
    if (micBtn) { micBtn.style.opacity = '0.3'; micBtn.disabled = true; }
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'id-ID';
  recognition.interimResults = false;
  recognition.continuous = false;
  State.recognition = recognition;

  recognition.onstart = () => {
    State.isMicActive = true;
    if (micBtn) micBtn.classList.add('mic-active');
    const input = $('chat-input');
    if (input) input.placeholder = '🎤 Listening…';
  };

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    const input = $('chat-input');
    if (input) { input.value = transcript; input.focus(); }
  };

  recognition.onend = () => {
    State.isMicActive = false;
    if (micBtn) micBtn.classList.remove('mic-active');
    const input = $('chat-input');
    if (input) input.placeholder = 'Ask about your climate data…';
  };

  recognition.onerror = () => recognition.onend();
}

// ── CSV EXPORT ─────────────────────────────────────────────────────────────────
function exportCSV(data) {
  const records = data || State.chartData;
  const labels = records.labels || State.chartData.labels;
  const temps = records.temps || State.chartData.temps;
  const hums = records.hums || State.chartData.hums;

  if (!labels || !labels.length) {
    alert('No data available to export.');
    return;
  }

  const header = 'Timestamp,Temperature (°C),Humidity (%)';
  const rows = labels.map((ts, i) => `"${ts}",${temps[i]},${hums[i]}`);
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `climateos-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportHistoryCSV() {
  if (!State.historyData.length) { alert('No history data.'); return; }
  const labels = State.historyData.map(r => r.timestamp);
  const temps = State.historyData.map(r => r.temperature);
  const hums = State.historyData.map(r => r.humidity);
  exportCSV({ labels, temps, hums });
}

// ── PDF EXPORT (History) ──────────────────────────────────────────────────────
function exportHistoryPDF() {
  const records = State.historyData;
  if (!records.length) { alert('No history data to export.'); return; }

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { alert('Pop-up blocked. Allow pop-ups to export PDF.'); return; }

  const rows = records.slice().reverse().map((r, i) => {
    const ts = new Date(r.timestamp).toLocaleString('id-ID', { hour12: false });
    const bg = i % 2 === 0 ? '#fff' : '#f9f9f7';
    const tempColor = r.temperature >= 32 ? '#E53E3E' : r.temperature >= 27 ? '#D97706' : '#059669';
    return `<tr style="background:${bg}">
      <td style="padding:7px 14px;font-family:monospace;font-size:12px;color:#555;white-space:nowrap;">${ts}</td>
      <td style="padding:7px 14px;text-align:right;font-weight:700;font-size:13px;color:${tempColor};">${r.temperature.toFixed(1)}</td>
      <td style="padding:7px 14px;text-align:right;font-weight:700;font-size:13px;color:#0284C7;">${r.humidity.toFixed(1)}</td>
      <td style="padding:7px 14px;font-size:12px;color:#555;">${r.device_id || '—'}</td>
    </tr>`;
  }).join('');

  const temps = records.map(r => r.temperature);
  const hums = records.map(r => r.humidity);
  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);

  win.document.write(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>ClimateOS — History Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111; background: #fff; padding: 32px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 2px solid #111; }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .meta { font-size: 12px; color: #666; margin-top: 4px; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .sum-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 14px; }
  .sum-label { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #888; }
  .sum-value { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { background: #f3f3f1; }
  th { padding: 9px 14px; text-align: left; font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #555; border-bottom: 1px solid #ddd; }
  th:nth-child(2), th:nth-child(3) { text-align: right; }
  td:nth-child(2), td:nth-child(3) { text-align: right; }
  tr:last-child td { border-bottom: none; }
  .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e5e5e5; font-size: 11px; color: #888; display: flex; justify-content: space-between; }
  @media print {
    body { padding: 24px; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>ClimateOS · History Report</h1>
    <div class="meta">Range: ${State.historyRange} &nbsp;·&nbsp; Generated: ${new Date().toLocaleString('id-ID', { hour12: false })} &nbsp;·&nbsp; Device: Semarang ESP32</div>
  </div>
  <button class="no-print" onclick="window.print()" style="padding:8px 18px;background:#111;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">⬇ Print / Save PDF</button>
</div>

<div class="summary">
  <div class="sum-card"><div class="sum-label">Records</div><div class="sum-value">${records.length}</div></div>
  <div class="sum-card" style="border-left:3px solid #E53E3E;"><div class="sum-label">Temp Range</div><div class="sum-value" style="color:#E53E3E;">${Math.min(...temps).toFixed(1)}° – ${Math.max(...temps).toFixed(1)}°C</div></div>
  <div class="sum-card" style="border-left:3px solid #0284C7;"><div class="sum-label">Humidity Range</div><div class="sum-value" style="color:#0284C7;">${Math.min(...hums).toFixed(1)}% – ${Math.max(...hums).toFixed(1)}%</div></div>
  <div class="sum-card"><div class="sum-label">Averages</div><div class="sum-value">${avg(temps)}°C / ${avg(hums)}%</div></div>
</div>

<table>
  <thead>
    <tr>
      <th>Timestamp</th>
      <th>Temperature (°C)</th>
      <th>Humidity (%)</th>
      <th>Device ID</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">
  <span>ClimateOS · ESP32 + Firebase + Gemini AI · Semarang, 2026</span>
  <span>Total ${records.length} records &nbsp;·&nbsp; Range: ${State.historyRange}</span>
</div>
</body></html>`);
  win.document.close();
}

// ── POLLING ───────────────────────────────────────────────────────────────────
function startPolling() {
  fetchLatestTelemetry();
  fetchHistory();
  setInterval(() => {
    fetchLatestTelemetry();
    fetchHistory();
  }, CONFIG.POLL_INTERVAL_MS);

  fetchStats();
  setInterval(fetchStats, CONFIG.STATS_INTERVAL_MS);

  fetchWeather();
  setInterval(fetchWeather, CONFIG.WEATHER_INTERVAL_MS);
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
function attachEventListeners() {
  // Navigation
  attachNavListeners();

  // Chat fab toggle
  const fabBtn = $('chat-fab-btn');
  if (fabBtn) fabBtn.addEventListener('click', toggleChat);

  const closeBtn = $('chat-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', toggleChat);

  // Chat send
  const sendBtn = $('btn-send');
  if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);

  const chatInput = $('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
  }

  // Mic
  const micBtn = $('btn-mic');
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (!State.recognition) return;
      State.isMicActive ? State.recognition.stop() : State.recognition.start();
    });
  }

  // Main chart range
  document.querySelectorAll('#page-dashboard .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#page-dashboard .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.chartRange = btn.dataset.range;
      fetchHistory();
    });
  });

  // History chart range
  document.querySelectorAll('#history-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#history-seg .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      fetchHistory(btn.dataset.range, true);
    });
  });

  // CSV export
  const csvBtn = $('btn-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', () => exportCSV());

  const csvHistBtn = $('btn-export-csv-history');
  if (csvHistBtn) csvHistBtn.addEventListener('click', exportHistoryCSV);

  // PDF export
  const pdfBtn = $('btn-history-pdf');
  if (pdfBtn) pdfBtn.addEventListener('click', exportHistoryPDF);
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  initMainChart();
  initHistoryChart();
  initSpeechRecognition();
  attachEventListeners();
  startClock();
  startPolling();
  console.info('[ClimateOS] v2 initialized ✓');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}