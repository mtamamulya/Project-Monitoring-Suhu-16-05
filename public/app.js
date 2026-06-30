/**
 * app.js — MediClimate RS Dashboard v2.2
 * Perbaikan v2.2: ROOM_CONFIG di-fetch dari /api/rooms (single source of truth),
 *   currentMode default 'publik', AI chat dengan conversation history.
 */

'use strict';

// ── CONFIG ────────────────────────────────────────────────────────────────────
// ROOM_CONFIG dimuat dari /api/rooms saat init. Nilai di bawah adalah FALLBACK
// jika backend tidak bisa dijangkau, sehingga UI tidak kosong.
let ROOM_CONFIG = [
  { id: "NICU-01",    name: "NICU",              floor: "Lt. 2", tempMin: 24, tempMax: 26, humMin: 50, humMax: 60 },
  { id: "BANGSAL-A",  name: "Bangsal Bayi",       floor: "Lt. 2", tempMin: 22, tempMax: 26, humMin: 45, humMax: 60 },
  { id: "BANGSAL-B",  name: "Bangsal Anak Umum",  floor: "Lt. 3", tempMin: 20, tempMax: 24, humMin: 40, humMax: 60 },
  { id: "ISOLASI-01", name: "Ruang Isolasi",       floor: "Lt. 3", tempMin: 22, tempMax: 25, humMin: 45, humMax: 55 },
];

const CONFIG = {
  FIREBASE_CONFIG: {
    apiKey: "AIzaSyBMDryeXRLcL2Pal1JfoT7XBK89_SZUkmc",
    authDomain: "project-monitoring-suhu-b3ca4.firebaseapp.com",
    projectId: "project-monitoring-suhu-b3ca4",
  },

  API_BASE_URL:        'https://climateos-backend.onrender.com',
  POLL_INTERVAL_MS:    10_000,
  WEATHER_INTERVAL_MS: 600_000,
  STATS_INTERVAL_MS:   120_000,
  GAUGE_ARC:           188,
  TEMP_MIN:            0,
  TEMP_MAX:            50,
};

// ── STATE ─────────────────────────────────────────────────────────────────────
const State = {
  latestTemp:   null,
  latestHum:    null,
  outdoor:      null,
  dashRange:    'live',
  histRange:    '3h',
  chartData:    { labels: [], temps: [], hums: [] },
  historyData:  [],
  isMicActive:  false,
  recognition:  null,
  currentPage:  '',           // kosong agar navigateTo('dashboard') tidak terkena guard
  chatHistory:  [],           // [{role: 'user'|'model', text: '...'}] — riwayat percakapan AI
  selectedRoom:    null,        // null = semua ruangan (dashboard switcher)
  histDevice:      null,        // null = semua ruangan (history filter)
  analysisRoom:    null,        // null = semua ruangan (analysis filter)
  sensorStatuses:  {},          // device_id → status ('online'|'offline'|'warning'|'never')
  notifSentFor:    {},          // device_id → last notified alert level ('ok'|'offline'|'warning'|'critical'|'emergency')
  mlRoom:          null,         // null = semua ruangan (ml analytics filter)
  mlRange:         7,            // rentang hari untuk analisis ML
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const $  = (id)  => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

// ── BROWSER PUSH NOTIFICATIONS ────────────────────────────────────────────────
function _initBrowserNotif() {
  if (!('Notification' in window)) return;
  const btn = $('notif-enable-btn');
  if (!btn) return;
  if (Notification.permission === 'granted') {
    btn.style.display = 'none';
  } else if (Notification.permission === 'denied') {
    btn.style.display = 'none'; // user explicitly blocked — don't nag
  } else {
    btn.style.display = 'inline-flex'; // show enable button
  }
}

function _showPushNotif(title, body, tag, sticky = false) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag, requireInteraction: sticky });
  } catch (e) { /* non-fatal */ }
}

window.enableBrowserNotif = async function() {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  const btn = $('notif-enable-btn');
  if (btn) btn.style.display = 'none';
  if (perm === 'granted') {
    _showPushNotif('MediClimate RS', 'Notifikasi aktif. Kamu akan menerima alert saat sensor offline atau kondisi kritis.', 'mediclimate-init');
  }
};

function _checkPushNotifForSensor(s) {
  if (!s || s.unknown || !s.device_id) return;
  const did  = s.device_id;
  const conf = ROOM_CONFIG.find(r => r.id === did);
  if (!conf) return;

  const prev = State.notifSentFor[did] || 'ok';
  let   curr = 'ok';

  if (s.status === 'offline' || s.status === 'never') {
    curr = 'offline';
  } else if (s.temperature != null) {
    const t = s.temperature, h = s.humidity ?? 50;
    if (t >= 32 || t <= 18) {
      curr = 'emergency';
    } else if (t > conf.tempMax + 2 || t < conf.tempMin - 2 || (h != null && (h > conf.humMax + 10 || h < conf.humMin - 10))) {
      curr = 'critical';
    } else if (t > conf.tempMax || t < conf.tempMin || (h != null && (h > conf.humMax || h < conf.humMin))) {
      curr = 'warning';
    }
  }

  if (curr !== prev) {
    State.notifSentFor[did] = curr;
    const name = conf.name;
    if (curr === 'offline') {
      _showPushNotif(`Sensor Offline: ${name}`, `Sensor ${name} tidak mengirim data. Periksa koneksi segera.`, `off-${did}`, true);
    } else if (curr === 'emergency') {
      _showPushNotif(`DARURAT: ${name}`, `Suhu ${s.temperature}°C — kondisi kritis, tindakan segera diperlukan!`, `emg-${did}`, true);
    } else if (curr === 'critical') {
      _showPushNotif(`Peringatan Kritis: ${name}`, `Suhu ${s.temperature}°C melebihi threshold. Periksa ruangan.`, `crit-${did}`, false);
    }
    // recovery (curr = 'ok' atau 'warning') — tidak perlu notif pop-up
  }
}

// ── NAVIGASI ──────────────────────────────────────────────────────────────────
function navigateTo(page) {
  State.currentPage = page;

  $$('.page').forEach(p => p.classList.remove('active'));
  const pageEl = $('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.bnav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));

  const titles = { dashboard: 'Dashboard', history: 'History', analysis: 'Analysis', 'ml-analytics': 'ML Analytics' };
  setText('page-title', titles[page] || page);

  if (page === 'history') fetchAndRenderHistory(State.histRange);
  if (page === 'analysis') updateAnalysisPage();
}

// ── GAUGE ─────────────────────────────────────────────────────────────────────
function updateGauge(arcId, valId, value, min, max) {
  const arc = $(arcId), val = $(valId);
  if (!arc || !val) return;
  const ratio  = Math.max(0, Math.min(1, (value - min) / (max - min)));
  arc.style.strokeDashoffset = CONFIG.GAUGE_ARC * (1 - ratio);
  val.textContent = value.toFixed(1);
}

// ── BADGE ─────────────────────────────────────────────────────────────────────
function tempBadge(t) {
  if (t < 20)  return { label: 'Cold',   style: 'background:var(--sky-soft);color:var(--sky);border-color:var(--sky);' };
  if (t <= 26) return { label: 'Normal', style: 'background:var(--emerald-soft);color:var(--emerald);border-color:var(--emerald);' };
  if (t < 32)  return { label: 'Warm',   style: 'background:var(--amber-soft);color:var(--amber);border-color:var(--amber);' };
  return { label: '⚠ Hot', style: 'background:var(--crit-soft);color:var(--crit);border-color:var(--crit);', critical: true };
}

function humBadge(h) {
  if (h < 40)  return { label: 'Dry',   style: 'background:var(--amber-soft);color:var(--amber);border-color:var(--amber);' };
  if (h <= 60) return { label: 'Ideal', style: 'background:var(--emerald-soft);color:var(--emerald);border-color:var(--emerald);' };
  if (h <= 75) return { label: 'Humid', style: 'background:var(--sky-soft);color:var(--sky);border-color:var(--sky);' };
  return { label: 'Muggy', style: 'background:var(--teal-soft);color:var(--teal);border-color:var(--teal);' };
}

function setBadge(id, cfg) {
  const el = $(id);
  if (!el) return;
  el.textContent  = cfg.label;
  el.className    = cfg.critical ? 'badge badge-critical' : 'badge tabular';
  el.setAttribute('style', cfg.style || '');
}

// ── COMPARE WIDGET ────────────────────────────────────────────────────────────
function updateCompare(iTemp, iHum, out) {
  setText('compare-indoor-temp', iTemp.toFixed(1) + '°');
  setText('compare-indoor-hum',  iHum.toFixed(1)  + '% RH');
  if (!out || out.temperature == null) return;

  const delta = iTemp - out.temperature;
  const sign  = delta >= 0 ? '+' : '';

  setText('compare-outdoor-temp', out.temperature.toFixed(1) + '°');
  setText('compare-outdoor-desc', out.description || '—');
  setText('delta-value',          sign + delta.toFixed(1) + '°C');
  setText('outdoor-feels', out.feels_like != null ? out.feels_like.toFixed(1) + '°C' : '—');
  setText('outdoor-wind',  out.wind_speed != null ? out.wind_speed.toFixed(1)        : '—');
  setText('outdoor-hum',   out.humidity   != null ? out.humidity + '%'               : '—');

  const dv = $('delta-value'), da = $('delta-arrow');
  if (!dv || !da) return;
  const abs = Math.abs(delta);
  if (abs < 0.5) {
    dv.className = 'num-md tabular delta-eq'; da.textContent = '⇄'; da.className = 'delta-eq';
  } else if (delta > 0) {
    dv.className = 'num-md tabular delta-up'; da.textContent = '↑'; da.className = 'delta-up';
  } else {
    dv.className = 'num-md tabular delta-down'; da.textContent = '↓'; da.className = 'delta-down';
  }
  da.style.fontSize = '22px';
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function updateStats(d) {
  setText('stat-min',   d.temp_min != null ? d.temp_min + '°C' : '—');
  setText('stat-max',   d.temp_max != null ? d.temp_max + '°C' : '—');
  setText('stat-avg',   d.temp_avg != null ? d.temp_avg + '°C' : '—');
  setText('stat-count', d.count    != null ? d.count.toLocaleString() : '—');
}

// ── GAUGE RESET & STALE INDICATOR ────────────────────────────────────────────

/**
 * Reset semua gauge, badge, comparison ke "—".
 * Dipanggil saat: pindah ke ruangan yang tidak ada data (404) atau switchRoom().
 */
function resetGauges() {
  // Reset temperature gauge arc + value
  const tempArc = $('gauge-temp-arc');
  if (tempArc) tempArc.style.strokeDashoffset = CONFIG.GAUGE_ARC;
  setText('gauge-temp-value', '—');

  // Reset humidity gauge arc + value
  const humArc = $('gauge-hum-arc');
  if (humArc) humArc.style.strokeDashoffset = CONFIG.GAUGE_ARC;
  setText('gauge-hum-value', '—');

  // Reset badges
  const bTemp = $('badge-temp');
  if (bTemp) { bTemp.textContent = '—'; bTemp.className = 'badge tabular'; bTemp.removeAttribute('style'); }
  const bHum = $('badge-hum');
  if (bHum) { bHum.textContent = '—'; bHum.className = 'badge tabular'; bHum.removeAttribute('style'); }

  // Reset compare widget
  setText('compare-indoor-temp', '—');
  setText('compare-indoor-hum',  '—');

  // Reset State
  State.latestTemp = null;
  State.latestHum  = null;

  // Sembunyikan stale banner
  _setGaugeStaleBanner(false);
}

/**
 * Tampilkan/sembunyikan banner peringatan data stale di atas bento-grid.
 * Dipakai ketika sensor offline tapi buffer masih punya data terakhirnya.
 * @param {boolean} show
 * @param {string}  [statusLabel] - misal 'Offline' atau 'Lambat'
 */
function _setGaugeStaleBanner(show, statusLabel) {
  let el = $('gauge-stale-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gauge-stale-banner';
    el.style.cssText = 'display:none; align-items:center; gap:8px; padding:8px 14px; '
      + 'background:var(--amber-soft); color:var(--amber); '
      + 'border:1px solid var(--amber); border-radius:8px; '
      + 'font-size:12.5px; font-weight:600; margin-bottom:12px;';
    const switcher = $('dashboard-room-switcher');
    if (switcher && switcher.parentNode) switcher.parentNode.insertBefore(el, switcher.nextSibling);
  }
  if (show && statusLabel) {
    el.innerHTML = `<svg style="width:14px;height:14px;flex-shrink:0;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`
      + ` Sensor <strong style="margin:0 2px;">${statusLabel}</strong> — menampilkan data terakhir sebelum koneksi terputus`;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

// ── CHARTS ────────────────────────────────────────────────────────────────────
let chartDash = null;
let chartHist = null;
let chartAnal = null;

function makeOpts(dualAxis) {
  const scales = {
    x: {
      type: 'time',
      time: { tooltipFormat: 'HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
      grid:   { color: 'rgba(128,128,128,0.12)', drawBorder: false },
      ticks:  { color: '#888', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0, maxTicksLimit: 7 },
      border: { display: false },
    },
  };
  if (dualAxis) {
    scales.yTemp = {
      position: 'left',
      grid:   { color: 'rgba(128,128,128,0.12)', drawBorder: false },
      ticks:  { color: '#fb923c', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + '°' },
      border: { display: false },
    };
    scales.yHum = {
      position: 'right', grid: { display: false },
      ticks:  { color: '#38bdf8', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + '%' },
      border: { display: false }, min: 0, max: 100,
    };
  } else {
    scales.y = {
      position: 'left',
      grid:   { color: 'rgba(128,128,128,0.12)', drawBorder: false },
      ticks:  { color: '#888', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + '°' },
      border: { display: false },
    };
  }
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1c1c1e', borderColor: '#3a3a3c', borderWidth: 1,
        titleColor: '#a1a1aa', bodyColor: '#f4f4f5',
        titleFont: { family: 'JetBrains Mono', size: 11 },
        bodyFont:  { family: 'JetBrains Mono', size: 12 },
        padding: 10,
      },
    },
    scales,
  };
}

function initCharts() {
  // Dashboard
  const c1 = $('climate-chart');
  if (c1 && !chartDash) {
    const ctx = c1.getContext('2d');
    const tg = ctx.createLinearGradient(0, 0, 0, 240);
    tg.addColorStop(0, 'rgba(251,146,60,0.22)'); tg.addColorStop(1, 'rgba(251,146,60,0)');
    const hg = ctx.createLinearGradient(0, 0, 0, 240);
    hg.addColorStop(0, 'rgba(56,189,248,0.18)'); hg.addColorStop(1, 'rgba(56,189,248,0)');
    chartDash = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Temperature (°C)', data: [], yAxisID: 'yTemp', borderColor: '#fb923c', backgroundColor: tg, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: true },
        { label: 'Humidity (%)',     data: [], yAxisID: 'yHum',  borderColor: '#38bdf8', backgroundColor: hg, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: true },
      ]},
      options: makeOpts(true),
    });
  }

  // History
  const c2 = $('history-chart');
  if (c2 && !chartHist) {
    chartHist = new Chart(c2.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Temperature (°C)', data: [], yAxisID: 'yTemp', borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.10)', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true },
        { label: 'Humidity (%)',     data: [], yAxisID: 'yHum',  borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true },
      ]},
      options: makeOpts(true),
    });
  }

  // Analysis
  const c3 = $('analysis-chart');
  if (c3 && !chartAnal) {
    const opts = makeOpts(false);
    opts.plugins.legend = { display: true, labels: { color: '#888', font: { family: 'JetBrains Mono', size: 11 }, boxWidth: 14 } };
    chartAnal = new Chart(c3.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Indoor °C',  data: [], yAxisID: 'y', borderColor: '#fb923c', borderWidth: 2, pointRadius: 0, tension: 0.4, fill: false },
        { label: 'Outdoor °C', data: [], yAxisID: 'y', borderColor: '#38bdf8', borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: 0.4, fill: false },
      ]},
      options: opts,
    });
  }
}

function feedChart(chart, records) {
  if (!chart || !records.length) return;
  chart.data.labels           = records.map(r => new Date(r.timestamp));
  chart.data.datasets[0].data = records.map(r => r.temperature);
  chart.data.datasets[1].data = records.map(r => r.humidity);
  chart.update('active');
}

// ── HISTORY TABLE ─────────────────────────────────────────────────────────────
function renderTable(records) {
  const tbody = $('history-tbody');
  if (!tbody) return;
  setText('hist-table-count', records.length + ' records');

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--muted-2);font-size:13px;">Tidak ada data untuk rentang waktu ini.</td></tr>';
    return;
  }

  tbody.innerHTML = records.slice().reverse().map((r, i) => {
    const ts   = new Date(r.timestamp).toLocaleString('id-ID', { hour12: false });
    const t    = r.temperature;
    const bg   = i % 2 === 0 ? 'transparent' : 'var(--bg-2)';
    let sBg = 'var(--emerald-soft)', sC = 'var(--emerald)', sL = 'Normal';
    if      (t >= 32) { sBg = 'var(--crit-soft)';  sC = 'var(--crit)';   sL = 'Hot';  }
    else if (t >= 27) { sBg = 'var(--amber-soft)'; sC = 'var(--amber)';  sL = 'Warm'; }
    else if (t < 20)  { sBg = 'var(--sky-soft)';   sC = 'var(--sky)';    sL = 'Cold'; }
    return `<tr style="background:${bg}">
      <td style="padding:9px 16px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hair);">${ts}</td>
      <td style="padding:9px 16px;text-align:right;font-weight:700;font-size:13px;color:var(--coral);border-bottom:1px solid var(--hair);">${t.toFixed(1)}</td>
      <td style="padding:9px 16px;text-align:right;font-weight:700;font-size:13px;color:var(--sky);border-bottom:1px solid var(--hair);">${r.humidity.toFixed(1)}</td>
      <td style="padding:9px 16px;border-bottom:1px solid var(--hair);">
        <span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:600;background:${sBg};color:${sC};">${sL}</span>
      </td>
    </tr>`;
  }).join('');
}

function renderSummary(records, range) {
  setText('hist-range-label', range);
  setText('hist-count', records.length.toLocaleString());
  if (records.length) {
    const ts = records.map(r => r.temperature);
    setText('hist-span', (Math.max(...ts) - Math.min(...ts)).toFixed(1) + '°C');
  } else {
    setText('hist-span', '—');
  }
}

// ── ANALYSIS PAGE ─────────────────────────────────────────────────────────────
function updateAnalysisPage() {
  const { outdoor } = State;
  const deviceParam = State.analysisRoom
    ? '?device_id=' + encodeURIComponent(State.analysisRoom)
    : '';

  // Reset semua nilai indoor ke placeholder
  setText('an-indoor-temp', '—');
  setText('an-avg-temp', '—'); setText('an-min-temp', '—'); setText('an-max-temp', '—');
  setText('an-delta-indoor', '—'); setText('an-delta-outdoor', '—'); setText('an-delta-result', '—');

  // Outdoor selalu pakai State.outdoor (bukan per-ruangan)
  if (outdoor) {
    setText('an-out-temp', outdoor.temperature != null ? outdoor.temperature.toFixed(1) + '°C' : '—');
    setText('an-feels',    outdoor.feels_like  != null ? outdoor.feels_like.toFixed(1)  + '°C' : '—');
    setText('an-out-hum',  outdoor.humidity    != null ? outdoor.humidity + '%'                : '—');
    setText('an-wind',     outdoor.wind_speed  != null ? outdoor.wind_speed.toFixed(1) + ' m/s': '—');
  }

  // Fetch latest untuk ruangan analysis yang dipilih
  fetch(CONFIG.API_BASE_URL + '/api/latest' + deviceParam)
    .then(r => (r.status === 404) ? null : r.ok ? r.json() : null)
    .then(d => {
      const t = d?.temperature ?? null;
      const h = d?.humidity    ?? null;
      setText('an-indoor-temp', t != null ? t.toFixed(1) + '°C' : '—');

      // Delta indoor vs outdoor
      setText('an-delta-indoor',  t != null                      ? t.toFixed(1) + '°C'                         : '—');
      setText('an-delta-outdoor', outdoor?.temperature != null   ? outdoor.temperature.toFixed(1) + '°C'        : '—');
      if (t != null && outdoor?.temperature != null) {
        const delta = t - outdoor.temperature;
        const sign  = delta >= 0 ? '+' : '';
        setText('an-delta-result', sign + delta.toFixed(1) + '°C');
        const card = $('an-delta-result-card'), txt = $('an-delta-result');
        if (card && txt) {
          if (delta > 3)       { card.style.background = 'var(--coral-soft)';  txt.style.color = 'var(--coral)'; }
          else if (delta < -3) { card.style.background = 'var(--sky-soft)';    txt.style.color = 'var(--sky)'; }
          else                 { card.style.background = 'var(--emerald-soft)'; txt.style.color = 'var(--emerald)'; }
        }
      }

      // Comfort cards pakai data ruangan yang dipilih
      updateComfort(t, h, outdoor);

      // Analysis chart — ambil data history 3h untuk ruangan yang dipilih
      if (!chartAnal) initCharts();
      if (chartAnal && outdoor?.temperature != null) {
        const histUrl = CONFIG.API_BASE_URL + '/api/history?range=3h' +
          (State.analysisRoom ? '&device_id=' + encodeURIComponent(State.analysisRoom) : '');
        fetch(histUrl)
          .then(r => r.ok ? r.json() : [])
          .then(hist => {
            if (!Array.isArray(hist) || !hist.length) return;
            const lbls  = hist.map(x => new Date(x.timestamp));
            const temps = hist.map(x => x.temperature);
            chartAnal.data.labels           = lbls;
            chartAnal.data.datasets[0].data = temps;
            chartAnal.data.datasets[1].data = lbls.map(() => outdoor.temperature);
            chartAnal.update('active');
          }).catch(() => {});
      }
    }).catch(() => {});

  // Stats (avg / min / max) — filter per ruangan
  fetch(CONFIG.API_BASE_URL + '/api/stats' + deviceParam)
    .then(r => r.ok ? r.json() : {})
    .then(d => {
      setText('an-avg-temp', d.temp_avg != null ? d.temp_avg + '°C' : '—');
      setText('an-min-temp', d.temp_min != null ? d.temp_min + '°C' : '—');
      setText('an-max-temp', d.temp_max != null ? d.temp_max + '°C' : '—');
    }).catch(() => {});
}

function updateComfort(temp, hum, outdoor) {
  // Helper: set left-border color on a card
  function setCardBorder(cardId, color) {
    const card = $(cardId);
    if (card) card.style.borderLeftColor = color;
  }

  // ── 1. Suhu Ruangan (Kemenkes RI: 22–26°C untuk bangsal anak) ──
  let tl = '—', tn = '—';
  let thermalColor = 'var(--muted)';
  if (temp != null) {
    if      (temp < 20)  { tl = '❄ Hipotermia Risk';   tn = 'Suhu terlalu rendah — risiko hipotermia pada neonatus'; thermalColor = 'var(--sky)'; }
    else if (temp < 22)  { tl = '⚠ Di Bawah Standar';  tn = 'Di bawah ambang Kemenkes (22°C), naikkan suhu ruangan'; thermalColor = 'var(--amber)'; }
    else if (temp <= 26) { tl = '✓ Sesuai Standar';     tn = 'Dalam rentang 22–26°C — optimal untuk pasien anak'; thermalColor = 'var(--emerald)'; }
    else if (temp <= 28) { tl = '⚠ Sedikit Tinggi';     tn = 'Di atas standar, risiko dehidrasi pada pasien anak'; thermalColor = 'var(--amber)'; }
    else if (temp <= 32) { tl = '⚠ Panas';              tn = 'Suhu tinggi — bisa memperburuk demam, segera ventilasi'; thermalColor = 'var(--coral)'; }
    else                 { tl = '🔴 Kritis';            tn = 'Bahaya heat stress — tindakan pendinginan segera'; thermalColor = 'var(--crit)'; }
  }
  setText('comfort-thermal', tl); setText('comfort-thermal-note', tn);
  setCardBorder('comfort-thermal-card', thermalColor);

  // ── 2. Kelembaban (WHO: 40–60% RH untuk fasilitas kesehatan) ──
  let hl = '—', hn = '—';
  let humColor = 'var(--muted)';
  if (hum != null) {
    if      (hum < 30)  { hl = '⚠ Sangat Kering'; hn = 'Iritasi mukosa, dehidrasi kulit, risiko infeksi saluran napas'; humColor = 'var(--amber)'; }
    else if (hum < 40)  { hl = '○ Agak Kering';   hn = 'Sedikit di bawah standar WHO, pantau kondisi pasien'; humColor = 'var(--amber)'; }
    else if (hum <= 60) { hl = '✓ Sesuai Standar'; hn = 'Dalam rentang 40–60% — optimal untuk pemulihan pasien'; humColor = 'var(--emerald)'; }
    else if (hum <= 70) { hl = '⚠ Agak Lembab';   hn = 'Mulai melebihi standar, risiko kontaminasi mikrobial'; humColor = 'var(--amber)'; }
    else                { hl = '🔴 Terlalu Lembab'; hn = 'Pertumbuhan jamur & bakteri aktif — berbahaya untuk imunokompromais'; humColor = 'var(--crit)'; }
  }
  setText('comfort-hum', hl); setText('comfort-hum-note', hn);
  setCardBorder('comfort-hum-card', humColor);

  // ── 3. Risiko Infeksi (berdasarkan kombinasi suhu + kelembaban) ──
  let il = '—', iNote = '—';
  let infColor = 'var(--muted)';
  if (temp != null && hum != null) {
    const humHigh = hum > 60;
    const tempWarm = temp > 26;
    if (humHigh && tempWarm) {
      il = '🔴 Tinggi'; iNote = 'Suhu hangat + kelembaban tinggi = kondisi ideal pertumbuhan patogen'; infColor = 'var(--crit)';
    } else if (humHigh) {
      il = '⚠ Sedang'; iNote = 'Kelembaban tinggi meningkatkan risiko jamur Aspergillus & Candida'; infColor = 'var(--amber)';
    } else if (hum < 30) {
      il = '⚠ Sedang'; iNote = 'Udara kering mengurangi pertahanan mukosa pasien terhadap infeksi'; infColor = 'var(--amber)';
    } else {
      il = '✓ Rendah'; iNote = 'Suhu & kelembaban dalam zona aman — risiko kontaminasi minimal'; infColor = 'var(--emerald)';
    }
  }
  setText('comfort-infection', il); setText('comfort-infection-note', iNote);
  setCardBorder('comfort-infection-card', infColor);

  // ── 4. Ventilasi & Sirkulasi (delta indoor vs outdoor) ──
  let dl = '—', dn = '—';
  let deltaColor = 'var(--muted)';
  if (temp != null && outdoor?.temperature != null) {
    const d = temp - outdoor.temperature;
    if (Math.abs(d) < 1)  { dl = '≈ Setara';                        dn = 'Tidak ada perbedaan signifikan — ventilasi alami berjalan'; deltaColor = 'var(--emerald)'; }
    else if (d > 5)       { dl = '+' + d.toFixed(1) + '°C lebih panas'; dn = 'Panas terperangkap — perlu buka ventilasi atau nyalakan AC'; deltaColor = 'var(--crit)'; }
    else if (d > 2)       { dl = '+' + d.toFixed(1) + '°C lebih hangat'; dn = 'Sedikit lebih hangat dari luar — pertimbangkan sirkulasi udara'; deltaColor = 'var(--amber)'; }
    else if (d > 0)       { dl = '+' + d.toFixed(1) + '°C'; dn = 'Sedikit di atas suhu luar, masih wajar'; deltaColor = 'var(--emerald)'; }
    else if (d < -5)      { dl = d.toFixed(1) + '°C lebih dingin'; dn = 'Pendinginan aktif bekerja baik, pastikan tidak overcooling'; deltaColor = 'var(--sky)'; }
    else                  { dl = d.toFixed(1) + '°C lebih sejuk'; dn = 'Ruangan lebih sejuk — AC/ventilasi berfungsi baik'; deltaColor = 'var(--emerald)'; }
  }
  setText('comfort-delta', dl); setText('comfort-delta-note', dn);
  setCardBorder('comfort-delta-card', deltaColor);

  // ── 5. Kenyamanan Pasien (kombinasi suhu + kelembaban untuk anak/neonatal) ──
  let pl = '—', pn = '—';
  let patientColor = 'var(--muted)';
  if (temp != null && hum != null) {
    const tempOk = temp >= 22 && temp <= 26;
    const humOk  = hum >= 40 && hum <= 60;
    if (tempOk && humOk) {
      pl = '✓ Optimal'; pn = 'Kondisi ideal untuk pemulihan pasien anak & neonatal'; patientColor = 'var(--emerald)';
    } else if ((temp >= 20 && temp <= 28) && (hum >= 35 && hum <= 65)) {
      pl = '○ Cukup Nyaman'; pn = 'Masih dapat ditoleransi, pantau kondisi pasien secara berkala'; patientColor = 'var(--amber)';
    } else {
      pl = '⚠ Tidak Nyaman'; pn = 'Kondisi di luar zona nyaman — risiko gangguan tidur & pemulihan lambat'; patientColor = 'var(--crit)';
    }
  }
  setText('comfort-patient', pl); setText('comfort-patient-note', pn);
  setCardBorder('comfort-patient-card', patientColor);

  // ── 6. Status Klinis Keseluruhan ──
  let ol = '—', on = '—', oa = '—';
  let overallColor = 'var(--muted)';
  if (temp != null && hum != null) {
    const tempOk  = temp >= 22 && temp <= 26;
    const humOk   = hum >= 40 && hum <= 60;
    const tempBad = temp > 32 || temp < 18;
    const humBad  = hum > 75 || hum < 25;
    const infRisk = hum > 60 && temp > 26;

    if (tempBad || humBad || infRisk) {
      ol = '🔴 Perlu Tindakan Segera'; on = 'Satu atau lebih parameter di luar batas aman klinis';
      oa = '⚡ Rekomendasi: Laporkan ke penanggung jawab bangsal & periksa HVAC';
      overallColor = 'var(--crit)';
    } else if (tempOk && humOk) {
      ol = '✓ Aman & Sesuai Standar'; on = 'Semua parameter dalam batas standar Kemenkes/WHO';
      oa = '✓ Tidak diperlukan tindakan — lanjutkan monitoring rutin';
      overallColor = 'var(--emerald)';
    } else {
      ol = '⚠ Perlu Perhatian'; on = 'Ada parameter yang mendekati atau sedikit melebihi batas standar';
      oa = '📋 Rekomendasi: Pantau perubahan dalam 30 menit ke depan';
      overallColor = 'var(--amber)';
    }
  }
  setText('comfort-overall', ol); setText('comfort-overall-note', on);
  setText('comfort-overall-action', oa);
  setCardBorder('comfort-overall-card', overallColor);
}

// ── CLOCK ─────────────────────────────────────────────────────────────────────
function startClock() {
  const tick = () => {
    const el = $('footer-time');
    if (el) el.textContent = new Date().toLocaleString('en-GB', {
      hour12: false, weekday: 'short', year: 'numeric',
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  };
  tick(); setInterval(tick, 1000);
}

// ── API FETCH ─────────────────────────────────────────────────────────────────

/** GET /api/latest → update gauge */
async function fetchLatest() {
  try {
    const url = CONFIG.API_BASE_URL + '/api/latest' +
      (State.selectedRoom ? '?device_id=' + encodeURIComponent(State.selectedRoom) : '');
    const res = await fetch(url);
    // 404 = device belum pernah kirim data → reset gauge ke "—" agar tidak tampilkan data ruangan lain
    if (res.status === 404) { resetGauges(); return; }
    if (!res.ok) { console.warn('[Latest] HTTP ' + res.status); return; }
    const d = await res.json();
    if (d.temperature == null) return;

    State.latestTemp = d.temperature;
    State.latestHum  = d.humidity;

    updateGauge('gauge-temp-arc', 'gauge-temp-value', d.temperature, CONFIG.TEMP_MIN, CONFIG.TEMP_MAX);
    updateGauge('gauge-hum-arc',  'gauge-hum-value',  d.humidity,    0, 100);
    setBadge('badge-temp', tempBadge(d.temperature));
    setBadge('badge-hum',  humBadge(d.humidity));

    if (State.outdoor) updateCompare(d.temperature, d.humidity, State.outdoor);
    setText('last-updated', new Date().toLocaleTimeString('en-GB', { hour12: false }));

    // ── Tampilkan banner jika sensor sedang offline tapi buffer masih punya data lama ──
    if (State.selectedRoom) {
      const st = State.sensorStatuses[State.selectedRoom];
      if (st === 'offline') {
        _setGaugeStaleBanner(true, 'Offline');
      } else if (st === 'warning') {
        _setGaugeStaleBanner(true, 'Lambat / Tidak Stabil');
      } else {
        _setGaugeStaleBanner(false);
      }
    } else {
      _setGaugeStaleBanner(false);
    }
  } catch (e) {
    console.warn('[Latest]', e.message);
  }
}

/**
 * GET /api/history?range=X → update chart dashboard
 * Backend support: live | 1h | 3h | 12h | 24h
 * range '6h' di-handle client-side
 */
async function fetchDashChart() {
  const range         = State.dashRange;
  const endpointRange = (range === '6h') ? '12h' : range;
  try {
    let url = CONFIG.API_BASE_URL + '/api/history?range=' + endpointRange;
    if (State.selectedRoom) url += '&device_id=' + encodeURIComponent(State.selectedRoom);
    const res = await fetch(url);
    if (!res.ok) { console.warn('[DashChart] HTTP ' + res.status); return; }
    let data = (await res.json()).data || [];

    if (range === '6h') {
      const cutoff = Date.now() - 6 * 3600 * 1000;
      data = data.filter(r => new Date(r.timestamp).getTime() >= cutoff);
    }

    feedChart(chartDash, data);
    State.chartData = {
      labels: data.map(r => r.timestamp),
      temps:  data.map(r => r.temperature),
      hums:   data.map(r => r.humidity),
    };
  } catch (e) {
    console.warn('[DashChart]', e.message);
  }
}

/** GET /api/history untuk halaman History */
async function fetchAndRenderHistory(range) {
  State.histRange = range;
  const endpointRange = (range === '6h') ? '12h' : range;
  try {
    let url = CONFIG.API_BASE_URL + '/api/history?range=' + endpointRange;
    if (State.histDevice) url += '&device_id=' + encodeURIComponent(State.histDevice);
    const res = await fetch(url);
    if (!res.ok) { console.warn('[History] HTTP ' + res.status); return; }
    let data = (await res.json()).data || [];

    if (range === '6h') {
      const cutoff = Date.now() - 6 * 3600 * 1000;
      data = data.filter(r => new Date(r.timestamp).getTime() >= cutoff);
    }

    State.historyData = data;
    feedChart(chartHist, data);
    renderTable(data);
    renderSummary(data, range);
  } catch (e) {
    console.warn('[History]', e.message);
  }
}

/** GET /api/stats */
async function fetchStats() {
  try {
    const url = CONFIG.API_BASE_URL + '/api/stats' +
      (State.selectedRoom ? '?device_id=' + encodeURIComponent(State.selectedRoom) : '');
    const res = await fetch(url);
    if (!res.ok) return;
    updateStats(await res.json());
  } catch (e) {
    console.warn('[Stats]', e.message);
  }
}

/** GET /api/weather */
async function fetchWeather() {
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/weather');
    if (!res.ok) return;
    const d = await res.json();
    State.outdoor = d;
    if (State.latestTemp != null) updateCompare(State.latestTemp, State.latestHum, d);
  } catch (e) {
    console.warn('[Weather]', e.message);
  }
}

// ── POLLING ───────────────────────────────────────────────────────────────────
function startPolling() {
  fetchLatest(); fetchDashChart(); fetchStats(); fetchWeather(); fetchSensorStatus();
  setInterval(() => { fetchLatest(); fetchDashChart(); fetchSensorStatus(); }, CONFIG.POLL_INTERVAL_MS);
  setInterval(fetchStats,   CONFIG.STATS_INTERVAL_MS);
  setInterval(fetchWeather, CONFIG.WEATHER_INTERVAL_MS);
}

// ── CHAT BUBBLE ───────────────────────────────────────────────────────────────
let chatOpen = false;

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = $('chat-panel'), fab = $('chat-fab-btn');
  if (panel) panel.classList.toggle('open', chatOpen);
  if (fab)   fab.classList.toggle('open', chatOpen);
  const badge = $('chat-fab-badge');
  if (badge && chatOpen) badge.classList.remove('show');
  if (chatOpen) setTimeout(() => { const i = $('chat-input'); if (i) i.focus(); }, 280);
}

function appendMsg(role, html) {
  const wrap = $('chat-messages');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = role === 'user' ? 'chat-user' : 'chat-ai';
  el.innerHTML = html
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

function showTyping() {
  if ($('typing-ind')) return;
  const wrap = $('chat-messages');
  if (!wrap) return;
  const el = document.createElement('div');
  el.id = 'typing-ind'; el.className = 'chat-ai';
  el.innerHTML = '<div style="display:flex;gap:5px;align-items:center;"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  wrap.appendChild(el); wrap.scrollTop = wrap.scrollHeight;
}

function hideTyping() { $('typing-ind')?.remove(); }

async function sendChat() {
  const input = $('chat-input'), sendBtn = $('btn-send');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  if (sendBtn) sendBtn.disabled = true;
  if (!chatOpen) toggleChat();
  appendMsg('user', msg);
  showTyping();

  // Tambah pesan user ke history sebelum dikirim
  State.chatHistory.push({ role: 'user', text: msg });
  // Batasi history 20 pesan terakhir (~10 bolak-balik) agar token usage terjaga
  if (State.chatHistory.length > 20) State.chatHistory = State.chatHistory.slice(-20);

  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Kirim history percakapan sebelumnya (tanpa pesan terbaru — sudah di 'message')
      body: JSON.stringify({ message: msg, history: State.chatHistory.slice(0, -1) }),
    });
    hideTyping();
    if (!res.ok) {
      const errMsg = ((await res.json().catch(() => ({}))).error || 'Terjadi kesalahan.');
      appendMsg('ai', '❌ ' + errMsg);
      // Batalkan penambahan ke history jika gagal
      State.chatHistory.pop();
    } else {
      const reply = (await res.json()).reply || '—';
      appendMsg('ai', reply);
      // Simpan balasan AI ke history
      State.chatHistory.push({ role: 'model', text: reply });
    }
  } catch (e) {
    hideTyping();
    appendMsg('ai', '❌ Gagal terhubung ke server.');
    State.chatHistory.pop();
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

// ── SPEECH ────────────────────────────────────────────────────────────────────
function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('btn-mic');
  if (!SR) { if (btn) { btn.style.opacity = '0.3'; btn.disabled = true; } return; }
  const r = new SR();
  r.lang = 'id-ID'; r.interimResults = false; r.continuous = false;
  State.recognition = r;

  r.onstart  = () => { State.isMicActive = true;  if (btn) btn.classList.add('mic-active');    const i = $('chat-input'); if (i) i.placeholder = '🎤 Mendengarkan…'; };
  r.onresult = e  => { const i = $('chat-input'); if (i) { i.value = e.results[0][0].transcript; i.focus(); } };
  r.onend    = () => { State.isMicActive = false; if (btn) btn.classList.remove('mic-active'); const i = $('chat-input'); if (i) i.placeholder = 'Tanya tentang data iklim kamu…'; };
  r.onerror  = () => r.onend();
}

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
function downloadCSV(labels, temps, hums, filename) {
  if (!labels.length) { alert('Tidak ada data untuk diekspor.'); return; }
  const csv = ['Timestamp,Temperature (°C),Humidity (%)']
    .concat(labels.map((t, i) => `"${t}",${temps[i]},${hums[i]}`))
    .join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })),
    download: filename,
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── EXPORT PDF ────────────────────────────────────────────────────────────────
function exportPDF() {
  const recs = State.historyData;
  if (!recs.length) { alert('Tidak ada data history.'); return; }
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { alert('Pop-up diblokir browser. Izinkan pop-up lalu coba lagi.'); return; }

  // Nama ruangan untuk judul laporan
  const roomLabel = State.histDevice
    ? (ROOM_CONFIG.find(r => r.id === State.histDevice)?.name || State.histDevice)
    : 'Semua Ruangan';
  const roomSlug = roomLabel.replace(/\s+/g, '-');

  const ts  = recs.map(r => r.temperature);
  const hs  = recs.map(r => r.humidity);
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);

  const rows = recs.slice().reverse().map((r, i) => {
    const t  = r.temperature;
    const tc = t >= 32 ? '#E53E3E' : t >= 27 ? '#D97706' : '#059669';
    const bg = i % 2 === 0 ? '#fff' : '#f9f9f7';
    const dt = new Date(r.timestamp).toLocaleString('id-ID', { hour12: false });
    return `<tr style="background:${bg}"><td>${dt}</td><td style="color:${tc};text-align:right;font-weight:700;">${t.toFixed(1)}</td><td style="color:#0284C7;text-align:right;font-weight:700;">${r.humidity.toFixed(1)}</td><td>${r.device_id || '—'}</td></tr>`;
  }).join('');

  w.document.write(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>MediClimate RS — History Report — ${roomLabel}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;padding:32px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:18px;border-bottom:2.5px solid #111}
h1{font-size:22px;font-weight:800;letter-spacing:-0.02em}.meta{font-size:12px;color:#666;margin-top:5px}
.room-badge{display:inline-block;margin-top:8px;padding:3px 10px;background:#f3f3f1;border:1px solid #ddd;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.04em;color:#444}
.sum{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
.sc{border:1px solid #e5e5e5;border-radius:8px;padding:12px 14px}.sl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888}.sv{font-size:22px;font-weight:800;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:12.5px}thead tr{background:#f3f3f1}
th{padding:9px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#555;border-bottom:1px solid #ddd}
th:nth-child(2),th:nth-child(3){text-align:right}td{padding:7px 14px;border-bottom:1px solid #f0f0ee}
.ftr{margin-top:22px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:11px;color:#888;display:flex;justify-content:space-between}
@media print{.np{display:none}}</style></head><body>
<div class="hdr"><div><h1>MediClimate RS · History Report</h1>
<div class="meta">Rentang: ${State.histRange} &nbsp;·&nbsp; Dibuat: ${new Date().toLocaleString('id-ID',{hour12:false})} &nbsp;·&nbsp; Semarang ESP32</div>
<div class="room-badge">📍 ${roomLabel}</div></div>
<button class="np" onclick="window.print()" style="padding:8px 18px;background:#111;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">⬇ Print / Save PDF</button></div>
<div class="sum">
  <div class="sc"><div class="sl">Records</div><div class="sv">${recs.length}</div></div>
  <div class="sc" style="border-left:3px solid #E53E3E"><div class="sl">Temp Range</div><div class="sv" style="color:#E53E3E">${Math.min(...ts).toFixed(1)}° – ${Math.max(...ts).toFixed(1)}°C</div></div>
  <div class="sc" style="border-left:3px solid #0284C7"><div class="sl">Humidity Range</div><div class="sv" style="color:#0284C7">${Math.min(...hs).toFixed(1)}% – ${Math.max(...hs).toFixed(1)}%</div></div>
  <div class="sc"><div class="sl">Rata-rata</div><div class="sv">${avg(ts)}°C / ${avg(hs)}%</div></div>
</div>
<table><thead><tr><th>Timestamp</th><th>Suhu (°C)</th><th>Kelembaban (%)</th><th>Device ID</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="ftr"><span>MediClimate RS · ESP32 + Firebase + Gemini · Semarang 2026</span><span>${recs.length} records · ${roomLabel} · Rentang: ${State.histRange}</span></div>
</body></html>`);
  w.document.close();
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
function attachListeners() {
  document.body.addEventListener('click', e => {
    // 1. Navigation
    const navBtn = e.target.closest('.nav-item[data-page], .bnav-item[data-page]');
    if (navBtn) {
      navigateTo(navBtn.dataset.page);
      return;
    }

    // 2. Chat Fab
    const fabBtn = e.target.closest('#chat-fab-btn');
    if (fabBtn) {
      toggleChat();
      return;
    }

    // 3. Chat Close
    const closeBtn = e.target.closest('#chat-close-btn');
    if (closeBtn) {
      toggleChat();
      return;
    }

    // 3b. Clear Chat
    const clearChatBtn = e.target.closest('#btn-clear-chat');
    if (clearChatBtn) {
      clearChat();
      return;
    }

    // 4. Send Chat
    const sendBtn = e.target.closest('#btn-send');
    if (sendBtn) {
      sendChat();
      return;
    }

    // 5. Mic
    const micBtn = e.target.closest('#btn-mic');
    if (micBtn) {
      if (State.recognition) {
        State.isMicActive ? State.recognition.stop() : State.recognition.start();
      }
      return;
    }

    // 6. Dashboard Range Selector
    const dashSeg = e.target.closest('#page-dashboard .seg-btn');
    if (dashSeg) {
      $$('#page-dashboard .seg-btn').forEach(b => b.classList.remove('active'));
      dashSeg.classList.add('active');
      State.dashRange = dashSeg.dataset.range;
      fetchDashChart();
      return;
    }

    // 7. History Range Selector
    const histSeg = e.target.closest('#history-seg .seg-btn');
    if (histSeg) {
      $$('#history-seg .seg-btn').forEach(b => b.classList.remove('active'));
      histSeg.classList.add('active');
      fetchAndRenderHistory(histSeg.dataset.range);
      return;
    }

    // 8. CSV Dashboard
    const csvDash = e.target.closest('#btn-export-csv');
    if (csvDash) {
      const dashRoom = State.selectedRoom
        ? (ROOM_CONFIG.find(r => r.id === State.selectedRoom)?.name || State.selectedRoom).replace(/\s+/g, '-')
        : 'semua-ruangan';
      downloadCSV(
        State.chartData.labels, State.chartData.temps, State.chartData.hums,
        'climateos-dashboard-' + dashRoom + '-' + new Date().toISOString().slice(0,10) + '.csv'
      );
      return;
    }

    // 9. CSV History
    const csvHist = e.target.closest('#btn-export-csv-history');
    if (csvHist) {
      const histRoom = State.histDevice
        ? (ROOM_CONFIG.find(r => r.id === State.histDevice)?.name || State.histDevice).replace(/\s+/g, '-')
        : 'semua-ruangan';
      downloadCSV(
        State.historyData.map(r => r.timestamp),
        State.historyData.map(r => r.temperature),
        State.historyData.map(r => r.humidity),
        'climateos-history-' + State.histRange + '-' + histRoom + '-' + new Date().toISOString().slice(0,10) + '.csv'
      );
      return;
    }

    // 10. PDF History
    const pdfBtn = e.target.closest('#btn-history-pdf');
    if (pdfBtn) {
      exportPDF();
      return;
    }
  });

  // Keep keydown listener attached directly to input
  const chatInput = $('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
  }

  // History device filter dropdown
  const histRoomFilter = $('history-room-filter');
  if (histRoomFilter) {
    histRoomFilter.addEventListener('change', () => {
      State.histDevice = histRoomFilter.value || null;
      fetchAndRenderHistory(State.histRange);
    });
  }
}

// ── FETCH ROOMS (single source of truth dari backend) ────────────────────────
async function fetchRooms() {
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/rooms');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      ROOM_CONFIG = data;
      console.info('[Rooms] ROOM_CONFIG diperbarui dari backend:', ROOM_CONFIG.length, 'ruangan');
    }
  } catch (e) {
    console.warn('[Rooms] Gagal fetch dari backend, pakai fallback lokal:', e.message);
  }
  // Selalu populate UI (baik dari backend maupun fallback lokal)
  _populateRoomSwitcher();
  _populateHistoryFilter();
  _populateAnalysisFilter();
  _populateMlRoomFilter();
}

function _populateRoomSwitcher() {
  const container = $('dashboard-room-switcher');
  if (!container) return;
  container.innerHTML = '<span class="label" style="margin-right:4px;">Ruangan:</span>';

  const allBtn = document.createElement('button');
  allBtn.className = 'seg-btn active';
  allBtn.dataset.room = '';
  allBtn.textContent = 'Semua';
  allBtn.onclick = () => window.switchRoom(allBtn, '');
  container.appendChild(allBtn);

  ROOM_CONFIG.forEach(room => {
    const btn = document.createElement('button');
    btn.className = 'seg-btn';
    btn.dataset.room = room.id;
    btn.textContent = room.name;
    btn.onclick = () => window.switchRoom(btn, room.id);
    container.appendChild(btn);
  });
}

function _populateHistoryFilter() {
  const sel = $('history-room-filter');
  if (!sel) return;
  // Hapus opsi lama (kecuali "Semua Ruangan")
  while (sel.options.length > 1) sel.remove(1);
  ROOM_CONFIG.forEach(room => {
    const opt = document.createElement('option');
    opt.value = room.id;
    opt.textContent = room.name + ' (' + room.id + ')';
    sel.appendChild(opt);
  });
}

function _populateAnalysisFilter() {
  const sel = $('analysis-room-filter');
  if (!sel) return;
  // Hapus opsi lama (kecuali "Semua Ruangan")
  while (sel.options.length > 1) sel.remove(1);
  ROOM_CONFIG.forEach(room => {
    const opt = document.createElement('option');
    opt.value = room.id;
    opt.textContent = room.name;
    sel.appendChild(opt);
  });
  // Pasang listener sekali
  if (!sel.dataset.listenerAttached) {
    sel.dataset.listenerAttached = '1';
    sel.addEventListener('change', () => {
      State.analysisRoom = sel.value || null;
      if (State.currentPage === 'analysis') updateAnalysisPage();
    });
  }
}

// ── ML ANALYTICS ──────────────────────────────────────────────
// Chart instances — disimpan agar bisa di-destroy sebelum rebuild
let _mlTempChart = null, _mlHumChart = null, _mlAnomalyChart = null, _mlKmeansChart = null;

function _populateMlRoomFilter() {
  const sel = $('ml-room-filter');
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  ROOM_CONFIG.forEach(room => {
    const opt = document.createElement('option');
    opt.value = room.id;
    opt.textContent = room.name;
    sel.appendChild(opt);
  });
  if (!sel.dataset.listenerAttached) {
    sel.dataset.listenerAttached = '1';
    sel.addEventListener('change', () => { State.mlRoom = sel.value || null; });
  }
  // Range seg buttons
  const seg = $('ml-range-seg');
  if (seg && !seg.dataset.listenerAttached) {
    seg.dataset.listenerAttached = '1';
    seg.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        State.mlRange = parseInt(btn.dataset.range, 10);
      });
    });
  }
}

function switchMlTab(tab) {
  const isPred = tab === 'predictive';
  $('ml-panel-predictive').style.display = isPred ? 'block' : 'none';
  $('ml-panel-xai').style.display        = isPred ? 'none'  : 'block';
  const btnP = $('ml-tab-predictive'), btnX = $('ml-tab-xai');
  if (btnP) { btnP.style.background = isPred ? 'var(--primary)' : 'var(--card)'; btnP.style.color = isPred ? '#fff' : 'var(--ink)'; btnP.style.borderColor = isPred ? 'var(--primary)' : 'var(--hair)'; }
  if (btnX) { btnX.style.background = isPred ? 'var(--card)' : 'var(--primary)'; btnX.style.color = isPred ? 'var(--ink)' : '#fff'; btnX.style.borderColor = isPred ? 'var(--hair)' : 'var(--primary)'; }
}

function _mlSetState(state) {
  $('ml-empty-state').style.display   = state === 'empty'   ? 'flex' : 'none';
  $('ml-loading-state').style.display = state === 'loading' ? 'flex' : 'none';
  $('ml-error-state').style.display   = state === 'error'   ? 'block': 'none';
  $('ml-results').style.display       = state === 'results' ? 'block': 'none';
}

function _destroyMlCharts() {
  if (_mlTempChart)    { _mlTempChart.destroy();    _mlTempChart    = null; }
  if (_mlHumChart)     { _mlHumChart.destroy();     _mlHumChart     = null; }
  if (_mlAnomalyChart) { _mlAnomalyChart.destroy(); _mlAnomalyChart = null; }
  if (_mlKmeansChart)  { _mlKmeansChart.destroy();  _mlKmeansChart  = null; }
}

function _mlChartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: 'var(--ink-2)', font: { size: 10 }, maxTicksLimit: 8 }, grid: { color: 'var(--hair)' } },
      y: { ticks: { color: 'var(--ink-2)', font: { size: 10 } }, grid: { color: 'var(--hair)' } },
    },
  };
}

function renderMlResults(d) {
  _destroyMlCharts();

  // Summary cards
  setText('ml-stat-temp',         d.temp_avg + '°C');
  setText('ml-stat-anomaly',      d.anomaly.count ?? '—');
  setText('ml-stat-count',        d.record_count + ' Valid');
  const fcastMax = d.temp_forecast.forecast ? Math.max(...d.temp_forecast.forecast).toFixed(2) : '—';
  setText('ml-stat-forecast-max', fcastMax + '°C');

  // ── 1. Forecasting Suhu ───────────────────────────────────
  const n = d.temps.length;
  const xLabels = d.timestamps.map((ts, i) => {
    if (!ts) return i;
    try { return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); } catch { return i; }
  });
  const futureLabels = Array.from({ length: d.temp_forecast.forecast?.length || 0 }, (_, i) => 'P' + (i + 1));

  _mlTempChart = new Chart($('ml-chart-temp-forecast'), {
    type: 'line',
    data: {
      labels: [...xLabels, ...futureLabels],
      datasets: [
        { label: 'Suhu Valid (°C)',       data: [...d.temps, ...Array(futureLabels.length).fill(null)], borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,.08)', tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        { label: 'Fitted (°C)',           data: [...(d.temp_forecast.fitted||[]), ...Array(futureLabels.length).fill(null)], borderColor: '#a78bfa', borderDash: [4,3], tension: 0, pointRadius: 0, borderWidth: 1.5 },
        { label: 'Prediksi Masa Depan',  data: [...Array(n).fill(null), ...(d.temp_forecast.forecast||[])], borderColor: '#f97316', borderDash: [6,3], tension: 0.2, pointRadius: 3, borderWidth: 2 },
      ],
    },
    options: { ..._mlChartDefaults(), plugins: { legend: { display: true, labels: { color: 'var(--ink-2)', font: { size: 10 }, boxWidth: 12 } } } },
  });

  // ── 2. Forecasting Kelembaban ─────────────────────────────
  _mlHumChart = new Chart($('ml-chart-hum-forecast'), {
    type: 'line',
    data: {
      labels: [...xLabels, ...futureLabels],
      datasets: [
        { label: 'Kelembaban Valid (%)',   data: [...d.hums, ...Array(futureLabels.length).fill(null)], borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,.08)', tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        { label: 'Prediksi Masa Depan (%)',data: [...Array(n).fill(null), ...(d.hum_forecast.forecast||[])], borderColor: '#f97316', borderDash: [6,3], tension: 0.2, pointRadius: 3, borderWidth: 2 },
      ],
    },
    options: { ..._mlChartDefaults(), plugins: { legend: { display: true, labels: { color: 'var(--ink-2)', font: { size: 10 }, boxWidth: 12 } } } },
  });

  // ── 3. Anomaly Detection ──────────────────────────────────
  const anomIdx = new Set(d.anomaly.anomaly_indices || []);
  const anomData = d.temps.map((t, i) => ({ x: i, y: t }));
  _mlAnomalyChart = new Chart($('ml-chart-anomaly'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Suhu Normal',  data: anomData.filter((_, i) => !anomIdx.has(i)), backgroundColor: 'rgba(6,182,212,.6)',  pointRadius: 3 },
        { label: 'Suhu Anomali', data: anomData.filter((_, i) =>  anomIdx.has(i)), backgroundColor: 'rgba(252,68,68,.8)', pointRadius: 5 },
      ],
    },
    options: { ..._mlChartDefaults(), plugins: { legend: { display: true, labels: { color: 'var(--ink-2)', font: { size: 10 }, boxWidth: 10 } } } },
  });

  // ── 4. K-Means ────────────────────────────────────────────
  const colorMap = { 'Profil Dingin': 'rgba(59,130,246,.7)', 'Profil Optimal': 'rgba(16,185,129,.7)', 'Profil Panas': 'rgba(239,68,68,.7)' };
  const kLabels  = d.kmeans.labels || [];
  const kDatasets = ['Profil Dingin', 'Profil Optimal', 'Profil Panas'].map(profile => ({
    label: profile,
    data:  d.temps.map((t, i) => kLabels[i] === profile ? { x: t, y: d.hums[i] } : null).filter(Boolean),
    backgroundColor: colorMap[profile],
    pointRadius: 4,
  }));
  _mlKmeansChart = new Chart($('ml-chart-kmeans'), {
    type: 'scatter',
    data: { datasets: kDatasets },
    options: {
      ..._mlChartDefaults(),
      scales: {
        x: { title: { display: true, text: 'Suhu (°C)', color: 'var(--ink-2)', font: { size: 10 } }, ticks: { color: 'var(--ink-2)', font: { size: 10 } }, grid: { color: 'var(--hair)' } },
        y: { title: { display: true, text: 'Kelembaban (%)', color: 'var(--ink-2)', font: { size: 10 } }, ticks: { color: 'var(--ink-2)', font: { size: 10 } }, grid: { color: 'var(--hair)' } },
      },
      plugins: { legend: { display: true, labels: { color: 'var(--ink-2)', font: { size: 10 }, boxWidth: 10 } } },
    },
  });

  // K-Means legend stats
  const legendEl = $('ml-kmeans-legend');
  if (legendEl) {
    legendEl.innerHTML = Object.entries(d.kmeans.cluster_stats || {}).map(([name, s]) =>
      `<span style="color:${colorMap[name] || 'inherit'};font-weight:600;">${name}</span>: ${s.count} data · ${s.temp_avg}°C · ${s.hum_avg}%`
    ).join(' &nbsp;|&nbsp; ');
  }

  // ── XAI: SHAP ─────────────────────────────────────────────
  const shap = d.shap || {};
  if (shap.hi_baseline != null) setText('ml-shap-baseline', shap.hi_baseline + '°C');
  const tImpact = shap.temp_impact ?? 0, hImpact = shap.hum_impact ?? 0;
  const tEl = $('ml-shap-temp'), hEl = $('ml-shap-hum');
  if (tEl) { tEl.textContent = (tImpact >= 0 ? '+' : '') + tImpact + '°C'; tEl.style.color = tImpact > 0 ? 'var(--crit)' : 'var(--emerald)'; }
  if (hEl) { hEl.textContent = (hImpact >= 0 ? '+' : '') + hImpact + '°C'; hEl.style.color = hImpact > 0 ? 'var(--amber)' : 'var(--emerald)'; }
  setText('ml-shap-temp-label', shap.temp_label || '');
  setText('ml-shap-hum-label', shap.hum_label || '');
  const dominant = d.kmeans.dominant || '';
  setText('ml-shap-conclusion', dominant
    ? `Kesimpulan SHAP: Suhu aktual terbukti menjadi faktor yang paling memengaruhi kondisi ruangan. Profil dominan: ${dominant}.`
    : '');

  // ── XAI: AI Insights via /api/chat ───────────────────────
  setText('ml-ai-insights', 'Memuat insight dari AI...');
  setText('ml-ai-recommendation', 'Memuat rekomendasi...');
  const prompt = `Kamu adalah asisten klinis AI untuk MediClimate RS. Berikan HANYA 2 bagian jawaban:

BAGIAN 1 — AI INSIGHTS (2-3 kalimat):
Data ML menunjukkan: rata-rata suhu ${d.temp_avg}°C, ${d.anomaly.count} anomali terdeteksi dari ${d.record_count} data, tren suhu ${(d.temp_forecast.coef||0) > 0 ? 'naik' : 'turun'} (koef ${(d.temp_forecast.coef||0).toFixed(3)}), profil dominan "${dominant}". Berikan analisis kondisi ruangan ini dari perspektif klinis untuk pasien bayi/neonatal.

BAGIAN 2 — REKOMENDASI (2-3 kalimat):
Berdasarkan data di atas, berikan rekomendasi tindakan konkret yang harus dilakukan tenaga medis.

Format jawaban:
INSIGHTS: [isi insights di sini]
REKOMENDASI: [isi rekomendasi di sini]

Gunakan bahasa Indonesia yang profesional namun mudah dipahami perawat.`;

  fetch(CONFIG.API_BASE_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: prompt, history: [] }),
  })
    .then(r => r.json())
    .then(data => {
      const reply = data.reply || '';
      const insightMatch = reply.match(/INSIGHTS:\s*([\s\S]*?)(?=REKOMENDASI:|$)/i);
      const rekoMatch    = reply.match(/REKOMENDASI:\s*([\s\S]*?)$/i);
      setText('ml-ai-insights',        insightMatch ? insightMatch[1].trim() : reply);
      setText('ml-ai-recommendation',  rekoMatch    ? rekoMatch[1].trim()   : 'Tidak ada rekomendasi khusus saat ini.');
    })
    .catch(() => {
      setText('ml-ai-insights',       'AI tidak tersedia saat ini.');
      setText('ml-ai-recommendation', 'Periksa koneksi dan coba lagi.');
    });

  _mlSetState('results');
  switchMlTab('predictive');
}

async function runMlAnalysis() {
  _mlSetState('loading');
  const btn = $('btn-start-analysis');
  if (btn) { btn.disabled = true; btn.textContent = 'Menganalisis...'; }

  const params = new URLSearchParams({ range: State.mlRange });
  if (State.mlRoom) params.set('device_id', State.mlRoom);

  try {
    const res  = await fetch(CONFIG.API_BASE_URL + '/api/analytics?' + params.toString());
    const data = await res.json();

    if (!res.ok || data.error) {
      $('ml-error-msg').textContent = data.error || 'Gagal menghubungi server.';
      _mlSetState('error');
    } else {
      renderMlResults(data);
    }
  } catch (e) {
    $('ml-error-msg').textContent = 'Koneksi ke server gagal: ' + e.message;
    _mlSetState('error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Start Analysis'; }
  }
}
window.runMlAnalysis  = runMlAnalysis;
window.switchMlTab    = switchMlTab;

function switchRoom(btn, roomId) {
  State.selectedRoom = roomId || null;
  $$('#dashboard-room-switcher .seg-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Reset gauge ke "—" seketika agar tidak tampilkan data sisa ruangan sebelumnya
  resetGauges();
  fetchLatest();
  fetchDashChart();
  fetchStats();
}
window.switchRoom = switchRoom;

function clearChat() {
  State.chatHistory = [];
  const wrap = $('chat-messages');
  if (!wrap) return;
  wrap.innerHTML = '<div class="chat-ai"><p style="color:var(--ink-2);">Good day. I have access to your <strong style="color:var(--ink);">live sensor stream</strong> and Semarang outdoor conditions. Ask me about anomalies, thermal comfort, or ventilation.</p></div>';
}

function togglePassword() {
  const passInput  = $('login-pass');
  const eyeIcon    = $('pass-eye-icon');
  const eyeOffIcon = $('pass-eyeoff-icon');
  if (!passInput) return;
  const isHidden = passInput.type === 'password';
  passInput.type = isHidden ? 'text' : 'password';
  if (eyeIcon)    eyeIcon.style.display    = isHidden ? 'none'  : 'block';
  if (eyeOffIcon) eyeOffIcon.style.display = isHidden ? 'block' : 'none';
}
window.togglePassword = togglePassword;

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  initCharts();
  initSpeech();
  attachListeners();
  startClock();
  await fetchRooms();   // Pastikan ROOM_CONFIG sudah terisi sebelum polling dimulai
  startPolling();
  initAuth();
  console.info('[MediClimate RS v2.2] OK — backend:', CONFIG.API_BASE_URL);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ─── AUTHENTICATION (Login System) ──────────────────────────
// Default 'publik' (bukan 'public') agar guard currentMode === 'publik' bekerja
// dengan benar sebelum Firebase Auth selesai verifikasi user.
let currentMode = 'publik'; // 'publik' | 'internal'

// ── INACTIVITY AUTO-LOGOUT ────────────────────────────────────
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 menit
let _inactivityTimer = null;

function _resetInactivityTimer() {
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => {
    if (currentMode === 'internal' && typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().signOut().then(() => {
        console.info('[Auth] Auto-logout: tidak aktif selama 30 menit');
      });
    }
  }, INACTIVITY_TIMEOUT_MS);
}

function _startInactivityTimer() {
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev => {
    document.addEventListener(ev, _resetInactivityTimer, { passive: true });
  });
  _resetInactivityTimer();
}

// ── AUTH INIT ─────────────────────────────────────────────────
function initAuth() {
  try {
    firebase.initializeApp(CONFIG.FIREBASE_CONFIG);
    // SESSION persistence: sesi habis ketika tab/browser ditutup (tidak tersimpan di localStorage)
    firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION)
      .then(() => {
        firebase.auth().onAuthStateChanged(user => {
          if (user) {
            showApp('internal', user);
            _startInactivityTimer();
          } else {
            showLogin();
          }
        });
      })
      .catch(e => {
        console.warn('[Auth] Gagal set SESSION persistence, fallback ke default:', e.message);
        firebase.auth().onAuthStateChanged(user => {
          if (user) { showApp('internal', user); _startInactivityTimer(); }
          else { showLogin(); }
        });
      });
  } catch (e) {
    console.error('[Auth] Firebase init error:', e);
    showLogin();
  }
}

function showLogin() {
  $('login-screen').style.display = 'flex';
  document.querySelector('.app-shell').style.display = 'none';
  if ($('sidebar-user')) $('sidebar-user').style.display = 'none';
}

function showApp(mode, user=null) {
  currentMode = mode;
  $('login-screen').style.display = 'none';
  document.querySelector('.app-shell').style.display = 'flex';
  
  if (mode === 'publik') {
    if ($('public-banner')) $('public-banner').style.display = 'block';
    
    // Hide extra navs
    $$('.sidebar-nav .nav-item').forEach(btn => {
      if (btn.dataset.page && btn.dataset.page !== 'dashboard') {
        btn.style.display = 'none';
      }
    });
    // Hide export/chat
    if ($('btn-export-csv')) $('btn-export-csv').style.display = 'none';
    if ($('chat-fab')) $('chat-fab').style.display = 'none';
    
    navigateTo('dashboard');
  } else {
    if ($('public-banner')) $('public-banner').style.display = 'none';
    $$('.sidebar-nav .nav-item').forEach(btn => btn.style.display = 'flex');
    if ($('btn-export-csv')) $('btn-export-csv').style.display = 'flex';
    if ($('chat-fab')) $('chat-fab').style.display = 'flex';
    _initBrowserNotif(); // prompt perawat untuk enable notifikasi

    if ($('sidebar-user')) {
      $('sidebar-user').style.display = 'block';
      $('user-email-text').textContent = user ? user.email : 'Internal Staff';
    }
    
    navigateTo('dashboard');
  }
}

window.showApp = showApp; // expose for public button

if ($('login-form')) {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value;
    const pass = $('login-pass').value;
    try {
      if (typeof firebase !== 'undefined' && firebase.auth) {
        await firebase.auth().signInWithEmailAndPassword(email, pass);
      } else {
        // Dummy login if firebase sdk not loaded or config failed
        showApp('internal', {email});
      }
    } catch (err) {
      $('login-error').textContent = err.message || 'Login gagal';
      $('login-error').style.display = 'block';
    }
  });
}

if ($('btn-logout')) {
  $('btn-logout').addEventListener('click', (e) => {
    e.preventDefault();
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().signOut();
    } else {
      showLogin();
    }
  });
}

// ─── ANTI-SLEEP / KEEP ALIVE ─────────────────────────────────
function keepAlive() {
  setInterval(() => {
    fetch(CONFIG.API_BASE_URL + '/ping').catch(() => {});
  }, 4 * 60 * 1000);
}

// ─── SENSOR STATUS ───────────────────────────────────────────
async function fetchSensorStatus() {
  if (currentMode === 'publik') return;
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/sensor-status');
    const data = await res.json();
    let onlineCount = 0;
    let hasOffline = false;
    let allOffline = true;
    let lastSeenAny = null;
    
    // Simpan status tiap sensor ke State agar fungsi lain bisa baca
    State.sensorStatuses = {};
    data.forEach(s => {
      if (s.device_id) State.sensorStatuses[s.device_id] = s.status;
      if (!s.unknown) {
        if (s.status === 'online' || s.status === 'warning') {
          onlineCount++;
          allOffline = false;
        }
        if (s.status === 'offline') hasOffline = true;
        // Track the most recent last_seen across all sensors
        if (s.last_seen) {
          const seen = new Date(s.last_seen);
          if (!lastSeenAny || seen > lastSeenAny) lastSeenAny = seen;
        }
      }
    });

    // Update sensor pill text
    if ($('sensor-pill-text')) {
      $('sensor-pill-text').textContent = `${onlineCount}/${ROOM_CONFIG.length} Sensor Online`;
    }

    // Toggle sensor pill offline/online styling
    const sensorPill = $('header-sensor-pill');
    if (sensorPill) {
      if (onlineCount === 0) {
        sensorPill.classList.add('sensor-offline');
      } else {
        sensorPill.classList.remove('sensor-offline');
      }
    }

    // Dashboard disconnect banner
    const dashBanner = $('dashboard-disconnect-banner');
    if (dashBanner) {
      if (onlineCount === 0) {
        dashBanner.classList.add('show');
        const subEl = $('disconnect-last-time');
        if (subEl) {
          if (lastSeenAny) {
            subEl.textContent = 'Data terakhir diterima: ' + lastSeenAny.toLocaleString('id-ID', { hour12: false });
          } else {
            subEl.textContent = 'Menunggu koneksi sensor ESP32…';
          }
        }
      } else {
        dashBanner.classList.remove('show');
      }
    }

    // Offline warning badge (di header Status Semua Ruangan)
    const offlineBanner = $('offline-warning-banner');
    if (offlineBanner) {
      offlineBanner.style.display = hasOffline ? 'flex' : 'none';
    }

    // Render room status grid di dashboard
    renderRoomGrid(data);

    // ── Browser push notification saat status sensor berubah ──
    data.forEach(_checkPushNotifForSensor);

    // ── Refresh stale banner sesuai status sensor terpilih saat ini ──
    if (State.selectedRoom && State.latestTemp != null) {
      const st = State.sensorStatuses[State.selectedRoom];
      if (st === 'offline') {
        _setGaugeStaleBanner(true, 'Offline');
      } else if (st === 'warning') {
        _setGaugeStaleBanner(true, 'Lambat / Tidak Stabil');
      } else {
        _setGaugeStaleBanner(false);
      }
    }

    return data;
  } catch (e) {
    console.warn('[SensorStatus]', e.message);
  }
}
// ── ROOM STATUS GRID ──────────────────────────────────────────
function renderRoomGrid(sensorData) {
  const grid = $('room-status-grid');
  if (!grid) return;

  // Map sensor data ke device_id agar mudah di-lookup
  const byDevice = {};
  sensorData.forEach(s => { byDevice[s.device_id] = s; });

  grid.innerHTML = ROOM_CONFIG.map(room => {
    const s    = byDevice[room.id] || {};
    const temp = s.temperature != null ? s.temperature : null;
    const hum  = s.humidity    != null ? s.humidity    : null;
    const status = s.status || 'never';

    // ── Status connectivity ──
    const connMap = {
      online:  { label: '● Online',         color: 'var(--emerald)' },
      warning: { label: '◔ Lambat',         color: 'var(--amber)'   },
      offline: { label: '○ Offline',        color: 'var(--crit)'    },
      never:   { label: '— Belum ada data', color: 'var(--muted)'   },
    };
    const conn = connMap[status] || connMap.never;

    // ── Ambil threshold (dari server atau fallback ROOM_CONFIG) ──
    const tempMin = s.tempMin != null ? s.tempMin : room.tempMin;
    const tempMax = s.tempMax != null ? s.tempMax : room.tempMax;
    const humMin  = s.humMin  != null ? s.humMin  : room.humMin;
    const humMax  = s.humMax  != null ? s.humMax  : room.humMax;

    // ── Klasifikasi kesehatan ruangan ──
    let cardClass = 'room-status-card';
    let healthLabel = '✓ Normal';
    let healthColor = 'var(--emerald)';

    if (status === 'offline' || status === 'never') {
      cardClass += ' room-offline';
      healthLabel = '— Tidak ada data';
      healthColor = 'var(--muted)';
    } else if (temp != null) {
      const tempBad = temp < tempMin - 2 || temp > tempMax + 2;
      const humBad  = hum != null && (hum < humMin - 10 || hum > humMax + 10);
      const tempWarn = temp < tempMin || temp > tempMax;
      const humWarn  = hum != null && (hum < humMin || hum > humMax);

      if (tempBad || humBad) {
        cardClass += ' room-critical';
        healthLabel = '⚠ Kritis';
        healthColor = 'var(--crit)';
      } else if (tempWarn || humWarn) {
        cardClass += ' room-warning';
        healthLabel = '⚡ Perhatian';
        healthColor = 'var(--amber)';
      }
    }

    // ── Warna nilai per threshold ──
    const tempColor = temp == null ? 'var(--muted)'
      : (temp < tempMin || temp > tempMax) ? 'var(--coral)' : 'var(--emerald)';
    const humColor = hum == null ? 'var(--muted)'
      : (hum < humMin || hum > humMax) ? 'var(--sky)' : 'var(--emerald)';

    const tempStr = temp != null ? temp.toFixed(1) + '°C' : '—';
    const humStr  = hum  != null ? hum.toFixed(1)  + '%'  : '—';
    const floor   = s.floor || room.floor || '';

    return `<div class="${cardClass}">
        <div class="room-card-header">
          <span class="room-card-name">${room.name}</span>
          ${floor ? `<span class="room-card-floor">${floor}</span>` : ''}
        </div>
        <div class="room-card-readings">
          <div class="room-reading">
            <div class="room-reading-label">Suhu</div>
            <div class="room-reading-value" style="color:${tempColor};">${tempStr}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px;">${tempMin}–${tempMax}°C</div>
          </div>
          <div class="room-reading">
            <div class="room-reading-label">Kelembaban</div>
            <div class="room-reading-value" style="color:${humColor};">${humStr}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px;">${humMin}–${humMax}%</div>
          </div>
        </div>
        <div class="room-card-footer">
          <span style="font-size:12px;font-weight:600;color:${healthColor};">${healthLabel}</span>
          <span style="font-size:11px;font-weight:500;color:${conn.color};">${conn.label}</span>
        </div>
      </div>`;
  }).join('');
}
