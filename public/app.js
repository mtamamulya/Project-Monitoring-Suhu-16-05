/**
 * app.js — ClimateOS Dashboard
 * Modular, production-grade vanilla JS using modern ES6+ async/await patterns.
 * Handles: real-time polling, gauge rendering, chart management, AI chat,
 *           Web Speech API (STT), CSV/PDF export, and dynamic UI state.
 */

'use strict';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // Ganti URL ini dengan URL Render kamu setelah deploy
  // Contoh: 'https://climateos-backend.onrender.com'
  API_BASE_URL: 'https://climateos-backend.onrender.com',

  POLL_INTERVAL_MS: 15_000,        // Telemetry refresh: 15 seconds
  WEATHER_INTERVAL_MS: 600_000,    // Outdoor weather: 10 minutes
  STATS_INTERVAL_MS: 60_000,       // Today's stats: 1 minute
  CHART_RANGE_DEFAULT: 'live',
  GAUGE_TOTAL_ARC_LENGTH: 188,     // SVG arc path total length
  TEMP_MAX: 50,
  TEMP_MIN: 0,
};

// ── MOCK DATA (ESP32 Simulator — replace with real API calls in production) ───
// In production this block is unused; the mock generator feeds /api/telemetry.
const MockESP32 = {
  _base: { temp: 28.5, hum: 72 },
  generate() {
    this._base.temp += (Math.random() - 0.48) * 0.6;
    this._base.hum += (Math.random() - 0.5) * 1.5;
    this._base.temp = Math.max(20, Math.min(40, this._base.temp));
    this._base.hum = Math.max(40, Math.min(95, this._base.hum));
    return {
      temperature: parseFloat(this._base.temp.toFixed(2)),
      humidity: parseFloat(this._base.hum.toFixed(2)),
      device_id: 'esp32-sim-01',
    };
  },
};

// ── STATE ─────────────────────────────────────────────────────────────────────
const State = {
  latestTemp: null,
  latestHum: null,
  outdoorTemp: null,
  chartRange: CONFIG.CHART_RANGE_DEFAULT,
  chartData: { labels: [], temps: [], hums: [] },
  chatHistory: [],     // For display reference
  isMicActive: false,
  recognition: null,
};

// ── DOM REFERENCES ────────────────────────────────────────────────────────────
const DOM = {
  // Gauges
  gaugeTempArc: document.getElementById('gauge-temp-arc'),
  gaugeTempValue: document.getElementById('gauge-temp-value'),
  gaugeHumArc: document.getElementById('gauge-hum-arc'),
  gaugeHumValue: document.getElementById('gauge-hum-value'),

  // Badges
  badgeTemp: document.getElementById('badge-temp'),
  badgeHum: document.getElementById('badge-hum'),

  // Header
  lastUpdated: document.getElementById('last-updated'),
  footerTime: document.getElementById('footer-time'),

  // Compare widget
  compareIndoorTemp: document.getElementById('compare-indoor-temp'),
  compareIndoorHum: document.getElementById('compare-indoor-hum'),
  compareOutdoorTemp: document.getElementById('compare-outdoor-temp'),
  compareOutdoorDesc: document.getElementById('compare-outdoor-desc'),
  deltaValue: document.getElementById('delta-value'),
  deltaArrow: document.getElementById('delta-arrow'),
  outdoorFeels: document.getElementById('outdoor-feels'),
  outdoorWind: document.getElementById('outdoor-wind'),
  outdoorHum: document.getElementById('outdoor-hum'),

  // Stats
  statMin: document.getElementById('stat-min'),
  statMax: document.getElementById('stat-max'),
  statAvg: document.getElementById('stat-avg'),
  statCount: document.getElementById('stat-count'),

  // Chart
  chartCanvas: document.getElementById('climate-chart'),

  // Chat
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  btnSend: document.getElementById('btn-send'),
  btnMic: document.getElementById('btn-mic'),

  // Export
  btnExportCsv: document.getElementById('btn-export-csv'),
  btnExportPdf: document.getElementById('btn-export-pdf'),
};

// ── GAUGE RENDERER ────────────────────────────────────────────────────────────
/**
 * Update an SVG semi-circular gauge arc based on a 0–1 progress ratio.
 * @param {SVGPathElement} arcEl - The arc path element.
 * @param {SVGTextElement} valueEl - The center text element.
 * @param {number} value - Current value.
 * @param {number} min - Scale minimum.
 * @param {number} max - Scale maximum.
 * @param {string} unit - Display unit string.
 */
function updateGauge(arcEl, valueEl, value, min, max) {
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const offset = CONFIG.GAUGE_TOTAL_ARC_LENGTH * (1 - ratio);
  arcEl.style.strokeDashoffset = offset;
  valueEl.textContent = value.toFixed(1);
}

// ── TEMPERATURE STATUS BADGE ──────────────────────────────────────────────────
/**
 * Returns badge config for a given temperature value.
 */
function getTempBadgeConfig(temp) {
  if (temp < 20) return { label: 'Cold', classes: 'bg-sky-500/20 text-sky-300 border border-sky-500/30', pulse: false };
  if (temp <= 26) return { label: 'Normal', classes: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30', pulse: false };
  if (temp < 32) return { label: 'Warm', classes: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30', pulse: false };
  return { label: '⚠ Hot', classes: 'bg-red-500/20 text-red-300 border border-red-500/30 badge-critical', pulse: true };
}

function getHumBadgeConfig(hum) {
  if (hum < 40) return { label: 'Dry', classes: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' };
  if (hum <= 60) return { label: 'Ideal', classes: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' };
  if (hum <= 75) return { label: 'Humid', classes: 'bg-sky-500/20 text-sky-300 border border-sky-500/30' };
  return { label: 'Muggy', classes: 'bg-violet-500/20 text-violet-300 border border-violet-500/30' };
}

function applyBadge(el, config) {
  el.className = `text-xs font-display font-600 px-2.5 py-0.5 rounded-full transition-all duration-500 ${config.classes}`;
  el.textContent = config.label;
}

// ── COMPARE / DELTA WIDGET ────────────────────────────────────────────────────
function updateCompareWidget(indoorTemp, indoorHum, outdoor) {
  DOM.compareIndoorTemp.textContent = `${indoorTemp.toFixed(1)}°`;
  DOM.compareIndoorHum.textContent = `${indoorHum.toFixed(1)}% RH`;

  if (outdoor && outdoor.temperature != null) {
    const delta = indoorTemp - outdoor.temperature;
    const sign = delta >= 0 ? '+' : '';
    const absD = Math.abs(delta);

    DOM.compareOutdoorTemp.textContent = `${outdoor.temperature.toFixed(1)}°`;
    DOM.compareOutdoorDesc.textContent = outdoor.description || '—';
    DOM.deltaValue.textContent = `${sign}${delta.toFixed(1)}°C`;
    DOM.outdoorFeels.textContent = outdoor.feels_like != null ? `${outdoor.feels_like.toFixed(1)}°C` : '—';
    DOM.outdoorWind.textContent = outdoor.wind_speed != null ? outdoor.wind_speed.toFixed(1) : '—';
    DOM.outdoorHum.textContent = outdoor.humidity != null ? outdoor.humidity : '—';

    // Color-code delta
    if (absD < 0.5) {
      DOM.deltaValue.className = 'font-display font-700 text-xl delta-eq';
      DOM.deltaArrow.textContent = '⇄';
      DOM.deltaArrow.className = 'text-2xl delta-eq';
    } else if (delta > 0) {
      DOM.deltaValue.className = 'font-display font-700 text-xl delta-up';
      DOM.deltaArrow.textContent = '↑';
      DOM.deltaArrow.className = 'text-2xl delta-up';
    } else {
      DOM.deltaValue.className = 'font-display font-700 text-xl delta-down';
      DOM.deltaArrow.textContent = '↓';
      DOM.deltaArrow.className = 'text-2xl delta-down';
    }
  }
}

// ── STATS CARDS ───────────────────────────────────────────────────────────────
function updateStatsCards(stats) {
  DOM.statMin.textContent = stats.temp_min != null ? `${stats.temp_min}°C` : '—';
  DOM.statMax.textContent = stats.temp_max != null ? `${stats.temp_max}°C` : '—';
  DOM.statAvg.textContent = stats.temp_avg != null ? `${stats.temp_avg}°C` : '—';
  DOM.statCount.textContent = stats.count != null ? stats.count.toLocaleString() : '—';
}

// ── CHART SETUP ───────────────────────────────────────────────────────────────
let climateChart = null;

function initChart() {
  const ctx = DOM.chartCanvas.getContext('2d');

  // Gradient fills
  const tempGradient = ctx.createLinearGradient(0, 0, 0, 260);
  tempGradient.addColorStop(0, 'rgba(251,146,60,0.25)');
  tempGradient.addColorStop(1, 'rgba(251,146,60,0)');

  const humGradient = ctx.createLinearGradient(0, 0, 0, 260);
  humGradient.addColorStop(0, 'rgba(56,189,248,0.2)');
  humGradient.addColorStop(1, 'rgba(56,189,248,0)');

  climateChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Temperature (°C)',
          data: [],
          yAxisID: 'yTemp',
          borderColor: '#fb923c',
          backgroundColor: tempGradient,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#fb923c',
          tension: 0.4,
          fill: true,
        },
        {
          label: 'Humidity (%)',
          data: [],
          yAxisID: 'yHum',
          borderColor: '#38bdf8',
          backgroundColor: humGradient,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#38bdf8',
          tension: 0.4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#18181b',
          borderColor: '#3f3f46',
          borderWidth: 1,
          titleColor: '#a1a1aa',
          bodyColor: '#f4f4f5',
          titleFont: { family: 'DM Mono', size: 11 },
          bodyFont: { family: 'DM Mono', size: 12 },
          padding: 10,
          callbacks: {
            label: (ctx) => {
              const label = ctx.dataset.label.split(' ')[0];
              const unit = ctx.datasetIndex === 0 ? '°C' : '%';
              return ` ${label}: ${ctx.parsed.y.toFixed(1)}${unit}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
          grid: { color: 'rgba(63,63,70,0.4)', drawBorder: false },
          ticks: { color: '#52525b', font: { family: 'DM Mono', size: 10 }, maxRotation: 0, maxTicksLimit: 8 },
          border: { display: false },
        },
        yTemp: {
          position: 'left',
          grid: { color: 'rgba(63,63,70,0.4)', drawBorder: false },
          ticks: {
            color: '#fb923c',
            font: { family: 'DM Mono', size: 10 },
            callback: (v) => `${v}°`,
          },
          border: { display: false },
          title: { display: false },
        },
        yHum: {
          position: 'right',
          grid: { display: false },
          ticks: {
            color: '#38bdf8',
            font: { family: 'DM Mono', size: 10 },
            callback: (v) => `${v}%`,
          },
          border: { display: false },
          min: 0,
          max: 100,
        },
      },
    },
  });
}

function updateChart(records) {
  if (!climateChart || !records.length) return;
  climateChart.data.labels = records.map((r) => new Date(r.timestamp));
  climateChart.data.datasets[0].data = records.map((r) => r.temperature);
  climateChart.data.datasets[1].data = records.map((r) => r.humidity);
  climateChart.update('active');
  // Update state for CSV export
  State.chartData = {
    labels: records.map((r) => r.timestamp),
    temps: records.map((r) => r.temperature),
    hums: records.map((r) => r.humidity),
  };
}

// ── TIME DISPLAY ──────────────────────────────────────────────────────────────
function formatTime(date = new Date()) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function startClock() {
  setInterval(() => {
    DOM.footerTime.textContent = new Date().toLocaleString('en-GB', {
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, 1000);
}

/**
 * Fetch the latest telemetry reading from history to update gauges.
 * The real ESP32 sends data directly to /api/telemetry.
 */
async function fetchLatestTelemetry() {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/history?range=live`);
    if (!res.ok) throw new Error(`Latest fetch failed: ${res.status}`);
    const { data } = await res.json();

    if (data && data.length > 0) {
      const latest = data[data.length - 1]; // newest record
      State.latestTemp = latest.temperature;
      State.latestHum = latest.humidity;

      updateGauge(DOM.gaugeTempArc, DOM.gaugeTempValue, latest.temperature, CONFIG.TEMP_MIN, CONFIG.TEMP_MAX);
      updateGauge(DOM.gaugeHumArc, DOM.gaugeHumValue, latest.humidity, 0, 100);
      applyBadge(DOM.badgeTemp, getTempBadgeConfig(latest.temperature));
      applyBadge(DOM.badgeHum, getHumBadgeConfig(latest.humidity));

      if (State.outdoor) {
        updateCompareWidget(latest.temperature, latest.humidity, State.outdoor);
      }
      DOM.lastUpdated.textContent = formatTime();
    }
  } catch (err) {
    console.warn('[Telemetry]', err.message);
  }
}

/**
 * Fetch historical telemetry for the chart.
 */
async function fetchHistory(range = State.chartRange) {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/history?range=${range}`);
    if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
    const { data } = await res.json();
    updateChart(data);
  } catch (err) {
    console.warn('[History]', err.message);
  }
}

/**
 * Fetch today's aggregate stats.
 */
async function fetchStats() {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/stats`);
    if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
    const data = await res.json();
    updateStatsCards(data);
  } catch (err) {
    console.warn('[Stats]', err.message);
  }
}

/**
 * Fetch outdoor Semarang weather.
 */
async function fetchWeather() {
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/api/weather`);
    if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`);
    const data = await res.json();
    State.outdoor = data;
    State.outdoorTemp = data.temperature;
    if (State.latestTemp !== null) {
      updateCompareWidget(State.latestTemp, State.latestHum, data);
    }
  } catch (err) {
    console.warn('[Weather]', err.message);
  }
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
/**
 * Append a message bubble to the chat window.
 */
function appendMessage(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = role === 'user' ? 'flex justify-end' : 'flex justify-start';

  const bubble = document.createElement('div');
  bubble.className = role === 'user'
    ? 'chat-user max-w-xl p-3 text-sm text-zinc-200'
    : 'chat-ai max-w-xl p-3 text-sm text-zinc-300 leading-relaxed';
  bubble.innerHTML = text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-100">$1</strong>');

  wrapper.appendChild(bubble);
  DOM.chatMessages.appendChild(wrapper);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
  State.chatHistory.push({ role, text });
}

/**
 * Show a typing indicator while waiting for AI response.
 */
function showTypingIndicator() {
  const id = 'typing-indicator';
  const existing = document.getElementById(id);
  if (existing) return;

  const wrapper = document.createElement('div');
  wrapper.id = id;
  wrapper.className = 'flex justify-start';

  const bubble = document.createElement('div');
  bubble.className = 'chat-ai p-3';
  bubble.innerHTML = `
    <div class="flex items-center gap-1.5 px-1">
      <div class="typing-dot w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
      <div class="typing-dot w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
      <div class="typing-dot w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
    </div>`;
  wrapper.appendChild(bubble);
  DOM.chatMessages.appendChild(wrapper);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  document.getElementById('typing-indicator')?.remove();
}

/**
 * Send user message to the Gemini /api/chat endpoint.
 */
async function sendChatMessage() {
  const message = DOM.chatInput.value.trim();
  if (!message) return;

  DOM.chatInput.value = '';
  DOM.btnSend.disabled = true;
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
      const err = await res.json();
      appendMessage('ai', `❌ ${err.error || 'Something went wrong. Please try again.'}`);
      return;
    }

    const { reply } = await res.json();
    appendMessage('ai', reply);
  } catch (err) {
    removeTypingIndicator();
    appendMessage('ai', '❌ Network error. Please check your connection and try again.');
    console.error('[Chat]', err);
  } finally {
    DOM.btnSend.disabled = false;
    DOM.chatInput.focus();
  }
}

// ── WEB SPEECH API (STT) ──────────────────────────────────────────────────────
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    DOM.btnMic.title = 'Speech recognition not supported in this browser';
    DOM.btnMic.style.opacity = '0.3';
    DOM.btnMic.disabled = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;
  State.recognition = recognition;

  recognition.onstart = () => {
    State.isMicActive = true;
    DOM.btnMic.querySelector('svg').classList.add('text-red-400');
    DOM.btnMic.querySelector('svg').classList.remove('text-zinc-500');
    DOM.btnMic.classList.add('mic-active');
    DOM.chatInput.placeholder = '🎤 Listening…';
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    DOM.chatInput.value = transcript;
    DOM.chatInput.focus();
  };

  recognition.onend = () => {
    State.isMicActive = false;
    DOM.btnMic.querySelector('svg').classList.remove('text-red-400');
    DOM.btnMic.querySelector('svg').classList.add('text-zinc-500');
    DOM.btnMic.classList.remove('mic-active');
    DOM.chatInput.placeholder = 'Ask about your climate data...';
  };

  recognition.onerror = (event) => {
    console.warn('[STT] Error:', event.error);
    recognition.onend();
  };
}

function toggleMic() {
  if (!State.recognition) return;
  if (State.isMicActive) {
    State.recognition.stop();
  } else {
    State.recognition.start();
  }
}

// ── CSV EXPORT ─────────────────────────────────────────────────────────────────
function exportCSV() {
  const { labels, temps, hums } = State.chartData;
  if (!labels.length) {
    alert('No chart data available to export.');
    return;
  }

  const header = 'Timestamp,Temperature (°C),Humidity (%)';
  const rows = labels.map((ts, i) => `"${ts}",${temps[i]},${hums[i]}`);
  const csvContent = [header, ...rows].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.setAttribute('href', url);
  link.setAttribute('download', `climateos-export-${timestamp}.csv`);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── PDF EXPORT (native print) ─────────────────────────────────────────────────
function exportPDF() {
  window.print();
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
function attachEventListeners() {
  // Chat send
  DOM.btnSend.addEventListener('click', sendChatMessage);
  DOM.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Microphone
  DOM.btnMic.addEventListener('click', toggleMic);

  // Export
  DOM.btnExportCsv.addEventListener('click', exportCSV);
  DOM.btnExportPdf.addEventListener('click', exportPDF);

  // Chart range segmented control
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      State.chartRange = btn.dataset.range;
      fetchHistory(State.chartRange);
    });
  });
}

// ── POLLING INTERVALS ─────────────────────────────────────────────────────────
function startPolling() {
  // Telemetry — read latest from real ESP32 data
  fetchLatestTelemetry();
  fetchHistory();
  setInterval(() => {
    fetchLatestTelemetry();
    fetchHistory(State.chartRange);
  }, CONFIG.POLL_INTERVAL_MS);

  // Stats
  fetchStats();
  setInterval(fetchStats, CONFIG.STATS_INTERVAL_MS);

  // Outdoor weather
  fetchWeather();
  setInterval(fetchWeather, CONFIG.WEATHER_INTERVAL_MS);
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
async function init() {
  initChart();
  initSpeechRecognition();
  attachEventListeners();
  startClock();
  startPolling();
  console.info('[ClimateOS] Dashboard initialized ✓');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
