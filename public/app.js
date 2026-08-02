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
  { id: "BERSALIN-01",     name: "Ruang Bersalin 1",   floor: "", tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 },
  { id: "BERSALIN-02",     name: "Ruang Bersalin 2",   floor: "", tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 },
  { id: "OBAT-01",         name: "Ruang Obat",         floor: "", tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 },
  { id: "PERINATOLOGI-01", name: "Ruang Perinatologi", floor: "", tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 },
  { id: "RAWATINAP-01",    name: "Ruang Rawat Inap 1", floor: "", tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 },
  { id: "NURSESTATION-01", name: "Nurse Station",      floor: "", tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 },
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
// Catatan lengkap /api/sensor-status per device (termasuk baterai), dipakai
// halaman detail ruangan. State.sensorStatuses hanya menyimpan status koneksi.
let _sensorStatusTerakhir = {};

const State = {
  latestTemp:   null,
  latestHum:    null,
  outdoor:      null,
  dashRange:    'live',
  histRange:    '3h',
  histMode:      'preset',    // 'preset' (live/1h/3h/.../24h) | 'range' (7d/30d/custom date-range)
  histRangeStart: null,       // YYYY-MM-DD — hanya terisi saat histMode === 'range'
  histRangeEnd:   null,
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

// ══ TOAST & MODAL ═══════════════════════════════════════════════════════════
// Menggantikan alert()/confirm()/prompt() bawaan browser. Selain tampilannya
// tidak bisa diatur dan terasa asing di dashboard ini, dialog bawaan MEMBLOKIR
// seluruh halaman — polling sensor ikut berhenti selama kotak terbuka. Untuk
// sistem monitoring yang ditinggal terbuka di nurse station, itu tidak pantas.

const _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => _ESC_MAP[c]);
}

const _TOAST_ICONS = {
  ok:   '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  err:  '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  warn: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z"/>',
  info: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
};

/**
 * Tampilkan notifikasi singkat.
 * @param {string} message  isi pesan (boleh multi-baris pakai \n)
 * @param {'ok'|'err'|'warn'|'info'} type
 * @param {{title?: string, duration?: number}} opts
 *        duration 0 = menetap sampai ditutup manual (untuk pesan penting).
 */
function toast(message, type = 'info', opts = {}) {
  const wrap = $('toast-wrap');
  if (!wrap) { console.log('[toast]', type, message); return; }

  const kind = _TOAST_ICONS[type] ? type : 'info';
  // Pesan error biasanya perlu dibaca sampai habis; pesan sukses cukup sekilas.
  const duration = opts.duration != null
    ? opts.duration
    : (kind === 'err' ? 8000 : kind === 'warn' ? 6500 : 4000);

  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML =
    '<svg class="toast-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">' + _TOAST_ICONS[kind] + '</svg>' +
    '<div class="toast-body">' +
      (opts.title ? '<strong class="toast-title">' + escHtml(opts.title) + '</strong>' : '') +
      escHtml(message).replace(/\n/g, '<br>') +
    '</div>' +
    '<button class="toast-close" type="button" aria-label="Tutup">&times;</button>';

  const hapus = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.toast-close').addEventListener('click', hapus);
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (duration > 0) setTimeout(hapus, duration);

  // Jangan biarkan menumpuk tanpa batas kalau banyak error beruntun.
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
  return el;
}
window.toast = toast;

let _modalResolve = null;

function _closeModal(hasil) {
  const bd = $('app-modal');
  if (!bd) return;
  bd.classList.remove('open');
  document.body.style.overflow = '';
  const r = _modalResolve;
  _modalResolve = null;
  if (r) r(hasil);
}

/**
 * Modal serbaguna berbasis Promise.
 * @param {object} o
 *   title, sub      — judul & keterangan
 *   bodyHtml        — isi kustom (form). Kosongkan untuk modal konfirmasi biasa.
 *   okText, cancelText
 *   danger          — warnai tombol OK sebagai tindakan berisiko
 *   onOpen(box)     — dipanggil setelah tampil (mis. untuk fokus input)
 *   validate(box)   — return string error untuk mencegah OK, atau nilai hasil
 * @returns {Promise<any>} null kalau dibatalkan
 */
function showModal(o = {}) {
  const bd = $('app-modal');
  // Jaring pengaman: kalau markup modal hilang (mis. index.html versi lama masih
  // ter-cache), jatuh ke confirm() bawaan. Jelek, tapi jauh lebih baik daripada
  // tombol yang diam saja tanpa memberi tahu apa pun.
  if (!bd) return Promise.resolve(confirm(o.title || 'Lanjutkan?') ? true : null);

  // Kalau ada modal lain terbuka, tutup dulu supaya tidak saling menimpa.
  if (_modalResolve) _closeModal(null);

  const box    = bd.querySelector('.modal-box');
  const okBtn  = $('app-modal-ok');
  const cxlBtn = $('app-modal-cancel');

  $('app-modal-title').textContent = o.title || '';
  const subEl = $('app-modal-sub');
  subEl.innerHTML = o.sub ? escHtml(o.sub).replace(/\n/g, '<br>') : '';
  subEl.style.display = o.sub ? '' : 'none';

  const bodyEl = $('app-modal-body');
  bodyEl.innerHTML = o.bodyHtml || '';
  bodyEl.style.display = o.bodyHtml ? '' : 'none';

  okBtn.textContent  = o.okText || 'OK';
  cxlBtn.textContent = o.cancelText || 'Batal';
  cxlBtn.style.display = o.hideCancel ? 'none' : '';
  okBtn.style.background = o.danger ? 'var(--crit)' : '';
  okBtn.style.borderColor = o.danger ? 'var(--crit)' : '';
  okBtn.disabled = false;

  bd.classList.add('open');
  document.body.style.overflow = 'hidden';   // cegah halaman ikut scroll

  return new Promise(resolve => {
    _modalResolve = resolve;

    const onOk = () => {
      if (typeof o.validate === 'function') {
        const hasil = o.validate(box);
        // validate() mengembalikan string = pesan error, hentikan.
        if (typeof hasil === 'string') {
          const errEl = box.querySelector('.modal-err');
          if (errEl) { errEl.textContent = hasil; errEl.classList.add('show'); }
          else toast(hasil, 'err');
          return;
        }
        _closeModal(hasil == null ? true : hasil);
        return;
      }
      _closeModal(true);
    };

    okBtn.onclick  = onOk;
    cxlBtn.onclick = () => _closeModal(null);
    bd.onclick     = (e) => { if (e.target === bd) _closeModal(null); };

    // Esc membatalkan, Enter menyetujui (kecuali sedang mengetik di textarea).
    const onKey = (e) => {
      if (!bd.classList.contains('open')) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape') { e.preventDefault(); _closeModal(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); onOk(); }
    };
    document.addEventListener('keydown', onKey);

    if (typeof o.onOpen === 'function') setTimeout(() => o.onOpen(box), 30);
  });
}
window.showModal = showModal;

/** Pengganti confirm() — mengembalikan true/false, tidak memblokir halaman. */
async function confirmDialog(title, sub, opts = {}) {
  const hasil = await showModal({
    title, sub,
    okText: opts.okText || 'Ya, lanjutkan',
    cancelText: opts.cancelText || 'Batal',
    danger: opts.danger,
  });
  return hasil === true;
}
window.confirmDialog = confirmDialog;

/**
 * fetch() yang otomatis menyertakan Firebase ID token.
 *
 * Backend kini memverifikasi token ini untuk semua endpoint yang mengubah data
 * (threshold, verifikator, entri verifikasi). Tanpa itu, siapa pun yang tahu URL
 * Render bisa memalsukan catatan kepatuhan yang dipakai sebagai bukti akreditasi.
 *
 * Token Firebase berumur 1 jam; getIdToken() otomatis memperbarui kalau sudah
 * mendekati kedaluwarsa, jadi aman dipanggil tiap request.
 */
async function authFetch(url, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  try {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      const user = firebase.auth().currentUser;
      if (user) {
        const token = await user.getIdToken();
        opts.headers['Authorization'] = 'Bearer ' + token;
      }
    }
  } catch (e) {
    // Gagal ambil token bukan alasan untuk membatalkan request — biarkan server
    // yang memutuskan menolak, supaya pesan errornya jelas bagi pengguna.
    console.warn('[Auth] Gagal ambil ID token:', e.message);
  }
  return fetch(url, opts);
}

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

// ── ALARM SUARA + NOTIFICATION BELL (native website alarm) ─────────────────────
// Suara pakai Web Audio API (beep) alih-alih file audio — tidak butuh CDN/asset
// tambahan, dan AudioContext-nya "di-unlock" oleh klik tombol "Aktifkan Suara"
// supaya lolos autoplay policy browser.
let _audioCtx = null;
let _alarmSoundEnabled = false;
let _alertsInitialized = false;
let _knownAlertKeys = new Set();

function _initAlarmSoundBtn() {
  const btn = $('btn-alarm-sound');
  if (btn && !_alarmSoundEnabled) btn.style.display = 'inline-flex';
}

window.enableAlarmSound = function () {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    _alarmSoundEnabled = true;
    const btn = $('btn-alarm-sound');
    if (btn) btn.style.display = 'none';
    playAlarmSound(); // konfirmasi bunyi sekali begitu diaktifkan
  } catch (e) { console.warn('[Alarm] Web Audio tidak didukung:', e.message); }
};

function playAlarmSound() {
  if (!_alarmSoundEnabled || !_audioCtx) return;
  try {
    const ctx = _audioCtx, now = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + i * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.35 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.35 + 0.28);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + i * 0.35); osc.stop(now + i * 0.35 + 0.3);
    }
  } catch (e) { /* non-fatal */ }
}

window.toggleNotifBell = function () {
  const panel = $('notif-bell-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

function renderNotifBell(alerts) {
  const list = $('notif-bell-list');
  if (!list) return;
  if (!alerts.length) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted-2);font-size:12.5px;">Belum ada notifikasi.</div>';
    return;
  }
  const levelColors = { 0: 'var(--emerald)', 1: 'var(--amber)', 2: 'var(--coral)', 3: 'var(--crit)' };
  list.innerHTML = alerts.map(a => {
    const color = levelColors[a.level] ?? 'var(--muted)';
    const time  = a.timestamp ? new Date(a.timestamp).toLocaleString('id-ID', { hour12: false }) : '—';
    const firstLine = (a.message || '').split('\n')[0];
    return `<div style="padding:10px 14px;border-bottom:1px solid var(--hair);">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        <span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;"></span>
        <span style="font-size:12.5px;font-weight:600;color:var(--ink);">${a.room_name || a.device_id || '—'}</span>
        <span style="font-size:10.5px;color:${color};font-weight:700;margin-left:auto;white-space:nowrap;">${a.level_label || ''}</span>
      </div>
      <div style="font-size:11.5px;color:var(--muted);">${firstLine}</div>
      <div style="font-size:10px;color:var(--muted-2);margin-top:3px;">${time}</div>
    </div>`;
  }).join('');
}

/** GET /api/alerts — polling untuk bell notifikasi + bunyi alarm saat ada alert baru level>=1 */
async function fetchAlerts() {
  if (currentMode === 'publik') return;
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/alerts?limit=20');
    if (!res.ok) return;
    const alerts = await res.json();
    if (!Array.isArray(alerts)) return;

    renderNotifBell(alerts);

    const currentKeys = new Set(alerts.map(a => (a.device_id || '') + '|' + (a.timestamp || '')));
    if (_alertsInitialized) {
      const hasNewUrgent = alerts.some(a => a.level >= 1 && !_knownAlertKeys.has((a.device_id || '') + '|' + (a.timestamp || '')));
      if (hasNewUrgent) playAlarmSound();
    }
    _knownAlertKeys = currentKeys;
    _alertsInitialized = true;

    const unread = alerts.filter(a => a.level >= 1).length;
    const badge = $('notif-bell-badge');
    if (badge) {
      if (unread > 0) { badge.textContent = unread > 9 ? '9+' : String(unread); badge.style.display = 'flex'; }
      else { badge.style.display = 'none'; }
    }
  } catch (e) {
    console.warn('[Alerts]', e.message);
  }
}

// Klik di luar panel bell → tutup
document.addEventListener('click', (e) => {
  const panel = $('notif-bell-panel'), btn = $('btn-notif-bell');
  if (!panel || panel.style.display === 'none') return;
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  panel.style.display = 'none';
});

// ── NAVIGASI ──────────────────────────────────────────────────────────────────
function navigateTo(page) {
  State.currentPage = page;

  $$('.page').forEach(p => p.classList.remove('active'));
  const pageEl = $('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.bnav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));

  const titles = { dashboard: 'Dashboard', history: 'History', analysis: 'Analysis', 'ml-analytics': 'ML Analytics', admin: 'Pengaturan', kepatuhan: 'Kepatuhan' };
  setText('page-title', titles[page] || page);

  // Dashboard selalu landing di overview grid — konsisten, tidak "nyangkut" di detail ruangan terakhir
  if (page === 'dashboard') backToOverview();
  if (page === 'history') fetchAndRenderHistory(State.histRange);
  if (page === 'analysis') updateAnalysisPage();
  if (page === 'admin') loadAdminPage();
  if (page === 'kepatuhan') loadKepatuhanPage();
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
/**
 * Ambil batas ruangan yang sedang ditampilkan. Badge HARUS mengikuti threshold
 * ruangan (dapat diubah admin, default Permenkes RI No. 72/2016: 15-25°C,
 * 45-55% RH) — bukan angka hardcoded. Sebelumnya badge memakai standar
 * kenyamanan umum (Normal 20-26°C, Ideal 40-60%) sehingga 26°C dilabeli
 * "Normal" padahal melanggar batas, dan grafik/alert bilang sebaliknya.
 */
function _activeRoomLimits() {
  const room = ROOM_CONFIG.find(r => r.id === State.selectedRoom);
  return {
    tempMin: room ? room.tempMin : 15,
    tempMax: room ? room.tempMax : 25,
    humMin:  room ? room.humMin  : 45,
    humMax:  room ? room.humMax  : 55,
  };
}

// Selisih di luar batas yang masih dianggap "hampir" (kuning) sebelum jadi merah.
const NEAR_LIMIT_TEMP_C = 2.0;
const NEAR_LIMIT_HUM_PCT = 5.0;

function tempBadge(t) {
  const { tempMin, tempMax } = _activeRoomLimits();
  if (t >= tempMin && t <= tempMax) {
    return { label: 'Normal', style: 'background:var(--emerald-soft);color:var(--emerald);border-color:var(--emerald);' };
  }
  if (t < tempMin) {
    return t >= tempMin - NEAR_LIMIT_TEMP_C
      ? { label: 'Agak Dingin', style: 'background:var(--sky-soft);color:var(--sky);border-color:var(--sky);' }
      : { label: '⚠ Terlalu Dingin', style: 'background:var(--crit-soft);color:var(--crit);border-color:var(--crit);', critical: true };
  }
  return t <= tempMax + NEAR_LIMIT_TEMP_C
    ? { label: 'Agak Panas', style: 'background:var(--amber-soft);color:var(--amber);border-color:var(--amber);' }
    : { label: '⚠ Terlalu Panas', style: 'background:var(--crit-soft);color:var(--crit);border-color:var(--crit);', critical: true };
}

function humBadge(h) {
  const { humMin, humMax } = _activeRoomLimits();
  if (h >= humMin && h <= humMax) {
    return { label: 'Normal', style: 'background:var(--emerald-soft);color:var(--emerald);border-color:var(--emerald);' };
  }
  if (h < humMin) {
    return h >= humMin - NEAR_LIMIT_HUM_PCT
      ? { label: 'Agak Kering', style: 'background:var(--amber-soft);color:var(--amber);border-color:var(--amber);' }
      : { label: '⚠ Terlalu Kering', style: 'background:var(--crit-soft);color:var(--crit);border-color:var(--crit);', critical: true };
  }
  return h <= humMax + NEAR_LIMIT_HUM_PCT
    ? { label: 'Agak Lembap', style: 'background:var(--sky-soft);color:var(--sky);border-color:var(--sky);' }
    : { label: '⚠ Terlalu Lembap', style: 'background:var(--crit-soft);color:var(--crit);border-color:var(--crit);', critical: true };
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

  // Batas diambil dari konfigurasi ruangan aktif (bisa diubah admin), bukan
  // angka tetap. Default Permenkes RI No. 72 Tahun 2016: 15–25°C dan 45–55% RH,
  // sama dengan yang dipakai formulir pencatatan manual RSND.
  const { tempMin, tempMax, humMin, humMax } = _activeRoomLimits();
  const rangeTemp = tempMin + '–' + tempMax + '°C';
  const rangeHum  = humMin + '–' + humMax + '%';

  // ── 1. Suhu Ruangan ──
  let tl = '—', tn = '—';
  let thermalColor = 'var(--muted)';
  if (temp != null) {
    if (temp >= tempMin && temp <= tempMax) {
      tl = '✓ Sesuai Standar'; tn = 'Dalam rentang ' + rangeTemp + ' sesuai Permenkes 72/2016'; thermalColor = 'var(--emerald)';
    } else if (temp < tempMin) {
      if (temp >= tempMin - NEAR_LIMIT_TEMP_C) {
        tl = '⚠ Di Bawah Standar'; tn = 'Di bawah batas ' + tempMin + '°C — naikkan suhu ruangan'; thermalColor = 'var(--amber)';
      } else {
        tl = '🔴 Terlalu Dingin'; tn = 'Jauh di bawah ' + tempMin + '°C — risiko hipotermia, tindakan segera'; thermalColor = 'var(--crit)';
      }
    } else {
      if (temp <= tempMax + NEAR_LIMIT_TEMP_C) {
        tl = '⚠ Di Atas Standar'; tn = 'Melebihi batas ' + tempMax + '°C — periksa pendingin ruangan'; thermalColor = 'var(--amber)';
      } else {
        tl = '🔴 Terlalu Panas'; tn = 'Jauh di atas ' + tempMax + '°C — risiko heat stress, tindakan pendinginan segera'; thermalColor = 'var(--crit)';
      }
    }
  }
  setText('comfort-thermal', tl); setText('comfort-thermal-note', tn);
  setCardBorder('comfort-thermal-card', thermalColor);

  // ── 2. Kelembaban ──
  let hl = '—', hn = '—';
  let humColor = 'var(--muted)';
  if (hum != null) {
    if (hum >= humMin && hum <= humMax) {
      hl = '✓ Sesuai Standar'; hn = 'Dalam rentang ' + rangeHum + ' sesuai Permenkes 72/2016'; humColor = 'var(--emerald)';
    } else if (hum < humMin) {
      if (hum >= humMin - NEAR_LIMIT_HUM_PCT) {
        hl = '⚠ Agak Kering'; hn = 'Di bawah batas ' + humMin + '% — pantau kondisi pasien'; humColor = 'var(--amber)';
      } else {
        hl = '🔴 Terlalu Kering'; hn = 'Jauh di bawah ' + humMin + '% — iritasi mukosa & risiko infeksi saluran napas'; humColor = 'var(--crit)';
      }
    } else {
      if (hum <= humMax + NEAR_LIMIT_HUM_PCT) {
        hl = '⚠ Agak Lembap'; hn = 'Melebihi batas ' + humMax + '% — risiko kontaminasi mikrobial'; humColor = 'var(--amber)';
      } else {
        hl = '🔴 Terlalu Lembap'; hn = 'Jauh di atas ' + humMax + '% — pertumbuhan jamur & bakteri aktif'; humColor = 'var(--crit)';
      }
    }
  }
  setText('comfort-hum', hl); setText('comfort-hum-note', hn);
  setCardBorder('comfort-hum-card', humColor);

  // ── 3. Risiko Infeksi (berdasarkan kombinasi suhu + kelembaban) ──
  let il = '—', iNote = '—';
  let infColor = 'var(--muted)';
  if (temp != null && hum != null) {
    // Ikut batas ruangan juga, bukan angka 60/26/30 yang lama.
    const humHigh  = hum > humMax;
    const tempWarm = temp > tempMax;
    if (humHigh && tempWarm) {
      il = '🔴 Tinggi'; iNote = 'Suhu hangat + kelembaban tinggi = kondisi ideal pertumbuhan patogen'; infColor = 'var(--crit)';
    } else if (humHigh) {
      il = '⚠ Sedang'; iNote = 'Kelembaban tinggi meningkatkan risiko jamur Aspergillus & Candida'; infColor = 'var(--amber)';
    } else if (hum < humMin - NEAR_LIMIT_HUM_PCT) {
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
  State.histMode  = 'preset';
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

/** Tanggal YYYY-MM-DD, offsetDays hari dari sekarang (mis. -7 = 7 hari lalu, 0 = hari ini) */
function _dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/history-range — rentang tanggal bebas (langsung dari Firestore, bukan
 * buffer 24 jam), dipakai tombol 7 Hari / 30 Hari dan date-range picker custom.
 * Wajib ada State.histDevice (endpoint backend tidak menerima "Semua Ruangan").
 */
async function fetchAndRenderHistoryRange(startStr, endStr, rangeLabel) {
  if (!State.histDevice) {
    toast('Pilih 1 ruangan spesifik dulu (bukan "Semua Ruangan") untuk mengambil rentang tanggal ini.', 'warn');
    return;
  }
  State.histRange = rangeLabel || (startStr + ' s/d ' + endStr);
  State.histMode  = 'range';
  State.histRangeStart = startStr;
  State.histRangeEnd   = endStr;
  try {
    const url = CONFIG.API_BASE_URL + '/api/history-range?device_id=' + encodeURIComponent(State.histDevice)
      + '&start=' + startStr + '&end=' + endStr;
    const res = await fetch(url);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))).error || ('HTTP ' + res.status);
      // Kegagalan paling sering di sini adalah composite index telemetry belum
      // dibuat — sebutkan langkah perbaikannya, jangan cuma lempar pesan mentah.
      const hint = /index/i.test(err)
        ? '\n\nComposite index Firestore untuk koleksi "telemetry" belum aktif.\nJalankan: firebase deploy --only firestore:indexes'
        : '';
      toast(err + hint, 'err', { title: 'Gagal ambil data' });
      return;
    }
    const data = (await res.json()).data || [];
    State.historyData = data;
    feedChart(chartHist, data);
    renderTable(data);
    renderSummary(data, State.histRange);
  } catch (e) {
    console.warn('[HistoryRange]', e.message);
    toast('Backend Render mungkin sedang bangun dari mode tidur. Tunggu ~40 detik lalu coba lagi.', 'err', { title: 'Tidak bisa terhubung' });
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
  fetchLatest(); fetchDashChart(); fetchStats(); fetchWeather(); fetchSensorStatus(); fetchAlerts();
  setInterval(() => { fetchLatest(); fetchDashChart(); fetchSensorStatus(); }, CONFIG.POLL_INTERVAL_MS);
  setInterval(fetchStats,   CONFIG.STATS_INTERVAL_MS);
  setInterval(fetchWeather, CONFIG.WEATHER_INTERVAL_MS);
  setInterval(fetchAlerts,  15_000); // bell notifikasi — polling lebih sering, endpoint ini ringan (dari memory)
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
  if (!labels.length) { toast('Tidak ada data untuk diekspor.', 'warn'); return; }
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
  if (!recs.length) { toast('Tidak ada data history.', 'warn'); return; }
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { toast('Pop-up diblokir browser. Izinkan pop-up untuk situs ini lalu coba lagi.', 'err', { title: 'Tidak bisa membuka jendela cetak' }); return; }

  // Nama ruangan untuk judul laporan
  const roomLabel = ROOM_CONFIG.find(r => r.id === State.histDevice)?.name
    || State.histDevice || '—';
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

// ── SHEET "LAINNYA" (mobile) ──────────────────────────────────────────────────
// Sidebar disembunyikan di bawah 1024px, sehingga ML Analytics, Pengaturan,
// ganti tema, dan LOGOUT tidak punya jalan masuk dari HP. Sheet ini menampungnya.
function openMoreSheet() {
  const sheet = $('more-sheet'), backdrop = $('more-sheet-backdrop');
  if (!sheet || !backdrop) return;
  // Tampilkan identitas sesi yang sedang aktif — di HP tidak ada sidebar-user.
  setText('more-sheet-user', 'Masuk sebagai: ' + _currentUserEmail);
  backdrop.classList.add('open');
  requestAnimationFrame(() => sheet.classList.add('open'));
  const btn = $('bnav-more');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';   // cegah halaman ikut scroll di belakang sheet
}

function closeMoreSheet() {
  const sheet = $('more-sheet'), backdrop = $('more-sheet-backdrop');
  if (!sheet || !backdrop) return;
  sheet.classList.remove('open');
  backdrop.classList.remove('open');
  const btn = $('bnav-more');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

function toggleMoreSheet() {
  const sheet = $('more-sheet');
  if (!sheet) return;
  sheet.classList.contains('open') ? closeMoreSheet() : openMoreSheet();
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
function attachListeners() {
  document.body.addEventListener('click', e => {
    // 1. Navigation — termasuk item di dalam sheet "Lainnya" (mobile)
    const navBtn = e.target.closest('.nav-item[data-page], .bnav-item[data-page], .more-sheet-item[data-page]');
    if (navBtn) {
      navigateTo(navBtn.dataset.page);
      closeMoreSheet();   // sheet selalu tertutup setelah memilih halaman
      return;
    }

    // 1b. Tombol "Lainnya" di bottom nav (mobile) + backdrop untuk menutup
    if (e.target.closest('#bnav-more')) { toggleMoreSheet(); return; }
    if (e.target.closest('#more-sheet-backdrop')) { closeMoreSheet(); return; }

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
      const customPanel = $('history-custom-range-panel');
      if (customPanel) customPanel.style.display = 'none';

      const r = histSeg.dataset.range;
      if (r === '7d')      fetchAndRenderHistoryRange(_dateStr(-7),  _dateStr(0), '7 Hari');
      else if (r === '30d') fetchAndRenderHistoryRange(_dateStr(-30), _dateStr(0), '30 Hari');
      else fetchAndRenderHistory(r);
      return;
    }

    // 7b. Toggle panel date-range custom (akreditasi)
    const customRangeBtn = e.target.closest('#btn-history-custom-range');
    if (customRangeBtn) {
      const panel = $('history-custom-range-panel');
      if (panel) panel.style.display = (panel.style.display === 'flex') ? 'none' : 'flex';
      return;
    }

    // 7c. Terapkan date-range custom
    const applyRangeBtn = e.target.closest('#btn-history-range-apply');
    if (applyRangeBtn) {
      const start = $('history-range-start')?.value;
      const end   = $('history-range-end')?.value;
      if (!start || !end) { toast('Pilih tanggal mulai dan tanggal akhir dulu.', 'warn'); return; }
      if (start > end)    { toast('Tanggal mulai harus sebelum atau sama dengan tanggal akhir.', 'warn'); return; }
      $$('#history-seg .seg-btn').forEach(b => b.classList.remove('active'));
      fetchAndRenderHistoryRange(start, end, start + ' s/d ' + end);
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

    // 11. Admin — simpan threshold ruangan
    const saveRoomBtn = e.target.closest('.btn-admin-save-room');
    if (saveRoomBtn) {
      const row = saveRoomBtn.closest('tr[data-device-id]');
      if (row) saveRoomThreshold(row);
      return;
    }

    // 12. Admin — tambah verifikator
    const addVerifBtn = e.target.closest('#btn-admin-add-verifikator');
    if (addVerifBtn) {
      addVerifikator();
      return;
    }

    // 13. Admin — hapus verifikator
    const delVerifBtn = e.target.closest('.btn-admin-delete-verifikator');
    if (delVerifBtn) {
      deleteVerifikator(delVerifBtn.dataset.id, delVerifBtn.dataset.name);
      return;
    }

    // 13b. Kepatuhan — ralat entri verifikasi yang salah input
    const koreksiBtn = e.target.closest('.btn-koreksi-verifikasi');
    if (koreksiBtn) {
      koreksiVerifikasi(koreksiBtn.dataset.id);
      return;
    }

    // 13c. Perbesar tanda tangan — ukuran kecil di tabel mustahil diperiksa mata
    const sigImg = e.target.closest('.js-sig-zoom');
    if (sigImg) {
      lihatTandaTangan(sigImg.dataset.sig);
      return;
    }

    // 13d. Lihat catatan lengkap. Di tabel teksnya terpotong, dan tooltip title
    //      tidak muncul sama sekali di layar sentuh — jadi harus bisa diketuk.
    const catatanBtn = e.target.closest('.js-lihat-catatan');
    if (catatanBtn) {
      lihatCatatanVerifikasi(catatanBtn.dataset.id);
      return;
    }

    // 13e. Kepatuhan — ambil ulang nilai dari sensor
    const ambilBtn = e.target.closest('#btn-ambil-sensor');
    if (ambilBtn) { ambilNilaiSensor(true); return; }

    // 14. Kepatuhan — tampilkan data ruangan+bulan terpilih
    const kepLoadBtn = e.target.closest('#btn-kepatuhan-load');
    if (kepLoadBtn) { fetchKepatuhanData(); return; }

    // 15. Kepatuhan — download PDF
    const kepPdfBtn = e.target.closest('#btn-kepatuhan-pdf');
    if (kepPdfBtn) { exportKepatuhanPDF(); return; }

    // 16. Kepatuhan — submit verifikasi shift
    const kepSubmitBtn = e.target.closest('#btn-kepatuhan-submit');
    if (kepSubmitBtn) { submitKepatuhanVerification(); return; }

    // 17. Kepatuhan — hapus tanda tangan
    const kepSigClearBtn = e.target.closest('#btn-kepatuhan-sig-clear');
    if (kepSigClearBtn) { clearSignaturePad(); return; }
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

  // Admin — Enter di input nama verifikator = submit
  const verifInput = $('admin-verifikator-name');
  if (verifInput) {
    verifInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addVerifikator(); }
    });
  }

  // History device filter dropdown
  const histRoomFilter = $('history-room-filter');
  if (histRoomFilter) {
    histRoomFilter.addEventListener('change', () => {
      State.histDevice = histRoomFilter.value || null;
      if (State.histMode === 'range' && State.histRangeStart && State.histRangeEnd) {
        fetchAndRenderHistoryRange(State.histRangeStart, State.histRangeEnd, State.histRange);
      } else {
        fetchAndRenderHistory(State.histRange);
      }
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
  _populateHistoryFilter();
  _populateAnalysisFilter();
  _populateMlRoomFilter();
  _populateKepatuhanRoomFilter();
}

/**
 * Isi ulang sebuah dropdown ruangan TANPA opsi "Semua Ruangan".
 *
 * Opsi itu dihapus dengan alasan yang sama seperti di Dashboard dulu: grafik
 * gabungan 6 ruangan tidak punya cara tampil yang bermakna — mau ditumpuk jadi
 * 12 garis tak terbaca, atau dirata-rata jadi angka yang tidak menggambarkan
 * ruangan mana pun. Setiap tampilan data kini SELALU spesifik 1 ruangan.
 */
function _isiDropdownRuangan(sel, withId = false) {
  const prev = sel.value;
  sel.innerHTML = ROOM_CONFIG.map(r =>
    `<option value="${r.id}">${escHtml(r.name)}${withId ? ' (' + r.id + ')' : ''}</option>`
  ).join('');
  // Pertahankan pilihan pengguna; kalau belum ada (atau ruangannya sudah
  // dihapus admin), jatuh ke ruangan pertama.
  sel.value = (prev && ROOM_CONFIG.some(r => r.id === prev)) ? prev : (ROOM_CONFIG[0]?.id || '');
  return sel.value || null;
}

function _populateHistoryFilter() {
  const sel = $('history-room-filter');
  if (!sel) return;
  State.histDevice = _isiDropdownRuangan(sel, true);
}

function _populateAnalysisFilter() {
  const sel = $('analysis-room-filter');
  if (!sel) return;
  State.analysisRoom = _isiDropdownRuangan(sel);
  // Pasang listener sekali
  if (!sel.dataset.listenerAttached) {
    sel.dataset.listenerAttached = '1';
    sel.addEventListener('change', () => {
      State.analysisRoom = sel.value;
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
  State.mlRoom = _isiDropdownRuangan(sel);
  if (!sel.dataset.listenerAttached) {
    sel.dataset.listenerAttached = '1';
    sel.addEventListener('change', () => { State.mlRoom = sel.value; });
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
  if (btnP) { btnP.classList.toggle('active', isPred); }
  if (btnX) { btnX.classList.toggle('active', !isPred); }
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

// ── ADMIN SETTINGS PAGE (threshold, verifikator, audit log) ────────────────────
async function loadAdminPage() {
  renderAdminRooms();
  renderVerifikatorList();
  renderAdminFirmware();
  renderAdminAuditLog();
}

/** Kotak pemberitahuan di atas daftar firmware. Judul wajib, penjelasan opsional. */
function _fwBanner(warna, judul, isi) {
  return `<div style="border-left:3px solid ${warna};background:var(--bg-2);
                      padding:10px 12px;border-radius:6px;margin-bottom:10px;">
      <div style="font-size:12.5px;font-weight:600;color:${warna};">${escHtml(judul)}</div>
      ${isi ? `<div style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:4px;">${isi}</div>` : ''}
    </div>`;
}

/**
 * Daftar versi firmware tiap alat.
 *
 * Dengan pembaruan jarak jauh, alat memperbarui dirinya sendiri — tapi tidak
 * selalu langsung: unit yang baterainya menipis atau sinyalnya lemah sengaja
 * menunda. Halaman ini yang memberi tahu unit mana yang masih tertinggal,
 * supaya tidak ada yang diam-diam berjalan dengan versi lama berbulan-bulan.
 */
async function renderAdminFirmware() {
  const list = $('admin-fw-list');
  const head = $('admin-fw-latest');
  if (!list) return;

  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/admin/firmware');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();

    if (head) {
      head.innerHTML = d.configured
        ? 'Versi terbaru: <strong>' + escHtml(d.latest) + '</strong>'
        : 'Pembaruan jarak jauh belum diaktifkan';
    }

    const unit = d.devices || [];

    // ── Ringkasan kunci perangkat ────────────────────────────────────────────
    // Ini yang menentukan aman-tidaknya menyalakan AUTH_ENFORCE. Ditaruh paling
    // atas karena akibat salah waktu di sini permanen: data yang ditolak 401
    // tidak disimpan di mana pun dan tidak bisa dikirim ulang.
    const bermasalah = d.kunci_bermasalah || [];
    const belumLapor = unit.filter(u => u.key_ok === null).length;
    let banner = '';

    if (d.auth_enforced) {
      banner = bermasalah.length
        ? _fwBanner('var(--crit)',
            'AUTH_ENFORCE aktif, tapi ' + bermasalah.length + ' alat memakai kunci yang salah',
            'Data dari ' + escHtml(bermasalah.join(', ')) + ' sedang <strong>ditolak dan hilang</strong>. ' +
            'Kembalikan AUTH_ENFORCE ke false di Render, atau flash ulang alat tersebut sekarang.')
        : _fwBanner('var(--emerald)', 'Terkunci — hanya alat dengan kunci yang benar bisa mengirim', '');
    } else if (bermasalah.length) {
      banner = _fwBanner('var(--amber)',
        bermasalah.length + ' alat belum memakai kunci yang benar',
        'Datanya masih diterima karena <code>AUTH_ENFORCE</code> belum aktif. ' +
        'Flash ulang <strong>' + escHtml(bermasalah.join(', ')) + '</strong> sebelum menyalakannya.');
    } else if (belumLapor === unit.length) {
      banner = _fwBanner('var(--muted-2)', 'Belum ada alat yang mengirim sejak server terakhir menyala',
        'Status kunci baru bisa dipastikan setelah tiap alat mengirim sekali.');
    } else {
      banner = _fwBanner('var(--emerald)',
        'Semua alat yang aktif sudah memakai kunci yang benar',
        belumLapor ? belumLapor + ' alat lain belum mengirim sejak server menyala, jadi belum bisa dipastikan.' : '');
    }

    list.innerHTML = banner + unit.map(u => {
      let warna, label;
      if (!d.configured)                    { warna = 'var(--muted-2)'; label = 'OTA nonaktif'; }
      else if (u.up_to_date === true)       { warna = 'var(--emerald)'; label = 'terbaru'; }
      else if (u.up_to_date === false)      { warna = 'var(--amber)';   label = 'menunggu pembaruan'; }
      else                                  { warna = 'var(--muted-2)'; label = 'belum melapor'; }

      let kWarna, kLabel;
      if (u.key_ok === true)       { kWarna = 'var(--emerald)'; kLabel = 'kunci ok'; }
      else if (u.key_ok === false) { kWarna = 'var(--crit)';    kLabel = 'kunci salah'; }
      else                         { kWarna = 'var(--muted-2)'; kLabel = 'kunci ?'; }

      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;
                          padding:8px 12px;background:var(--bg-2);border-radius:8px;">
          <span style="font-size:13px;font-weight:500;">${escHtml(u.room_name)}</span>
          <span style="display:flex;align-items:center;gap:8px;white-space:nowrap;">
            <span style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--muted);">
              ${escHtml(u.fw_version || '—')}</span>
            <span style="font-size:11px;font-weight:600;color:${kWarna};">${kLabel}</span>
            <span style="font-size:11px;font-weight:600;color:${warna};">${label}</span>
          </span>
        </div>`;
    }).join('');

    if (!d.configured) {
      list.innerHTML +=
        '<p style="font-size:12.5px;color:var(--muted);line-height:1.65;margin-top:10px;">' +
          'Set <code>FIRMWARE_VERSION</code> dan <code>FIRMWARE_URL</code> di dashboard Render ' +
          'untuk mengaktifkan pembaruan jarak jauh. Selama belum diset, alat tetap berjalan normal ' +
          'dengan firmware yang terpasang.' +
        '</p>';
    }

  } catch (e) {
    list.innerHTML = '<p style="color:var(--crit);font-size:12.5px;">Gagal memuat versi firmware.</p>';
  }
}

async function renderAdminRooms() {
  const tbody = $('admin-rooms-tbody');
  if (!tbody) return;
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/rooms');
    const rooms = res.ok ? await res.json() : [];
    if (!rooms.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted-2);">Tidak ada data ruangan.</td></tr>';
      return;
    }
    const fieldCell = (val, field) =>
      `<td style="padding:8px 10px;text-align:center;"><input type="number" step="0.1" class="input admin-th-input" data-field="${field}" value="${val}" style="width:72px;text-align:center;font-size:12.5px;padding:5px;height:auto;" /></td>`;
    tbody.innerHTML = rooms.map(r => `
      <tr data-device-id="${r.id}" style="border-bottom:1px solid var(--hair);">
        <td style="padding:8px 10px;font-weight:600;white-space:nowrap;">${r.name}</td>
        ${fieldCell(r.tempMin, 'tempMin')}
        ${fieldCell(r.tempMax, 'tempMax')}
        ${fieldCell(r.humMin, 'humMin')}
        ${fieldCell(r.humMax, 'humMax')}
        ${fieldCell(r.tempOffset ?? 0, 'tempOffset')}
        ${fieldCell(r.humOffset ?? 0, 'humOffset')}
        <td style="padding:8px 10px;"><button class="btn-ghost btn-admin-save-room" style="font-size:12px;padding:5px 10px;white-space:nowrap;">Simpan</button></td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--crit);">Gagal memuat data ruangan.</td></tr>';
  }
}

async function saveRoomThreshold(row) {
  const deviceId = row.dataset.deviceId;
  const updates = {};
  row.querySelectorAll('.admin-th-input').forEach(inp => { updates[inp.dataset.field] = parseFloat(inp.value); });
  if (Object.values(updates).some(v => Number.isNaN(v))) { toast('Semua nilai threshold harus angka.', 'warn'); return; }

  // Feedback langsung di tombol. Tanpa ini, request yang memakan 30-60 detik
  // (cold start Render free tier) terasa seperti aplikasi hang, dan user
  // cenderung mengklik berulang kali sehingga menumpuk request.
  const btn = row.querySelector('.btn-admin-save-room');
  const originalLabel = btn ? btn.textContent : '';
  const setBtn = (text, disabled, color) => {
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = !!disabled;
    btn.style.color = color || '';
  };
  setBtn('Menyimpan…', true);

  // Kalau lebih dari 8 detik, hampir pasti backend sedang bangun dari tidur.
  const slowTimer = setTimeout(() => setBtn('Membangunkan server…', true), 8000);

  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/admin/rooms/' + encodeURIComponent(deviceId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates, changed_by: _currentUserEmail }),
    });
    clearTimeout(slowTimer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBtn(originalLabel || 'Simpan', false);
      toast(data.error || 'unknown error', 'err', { title: 'Gagal simpan threshold' });
      return;
    }
    setBtn('✓ Tersimpan', true, 'var(--emerald)');
    await fetchRooms();      // refresh ROOM_CONFIG global (dipakai dashboard, history, dll)
    renderAdminAuditLog();
    setTimeout(() => setBtn(originalLabel || 'Simpan', false), 2000);
  } catch (e) {
    clearTimeout(slowTimer);
    setBtn(originalLabel || 'Simpan', false);
    toast('Backend Render free tier tidur setelah ~15 menit tanpa aktivitas; request pertama butuh 30-60 detik untuk membangunkannya. Tunggu sebentar lalu coba lagi.',
          'err', { title: 'Gagal terhubung ke server' });
  }
}

async function renderVerifikatorList() {
  const list = $('admin-verifikator-list');
  if (!list) return;
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/verifikators');
    const items = res.ok ? await res.json() : [];
    if (!items.length) {
      list.innerHTML = '<p style="color:var(--muted-2);font-size:12.5px;">Belum ada verifikator terdaftar.</p>';
      return;
    }
    list.innerHTML = items.map(v => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-2);border-radius:8px;">
        <span style="font-size:13px;font-weight:500;">${v.name}</span>
        <button class="btn-ghost btn-admin-delete-verifikator" data-id="${v.id}" data-name="${v.name.replace(/"/g,'&quot;')}" style="font-size:11.5px;padding:4px 10px;color:var(--crit);">Hapus</button>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = '<p style="color:var(--crit);font-size:12.5px;">Gagal memuat daftar verifikator.</p>';
  }
}

async function addVerifikator() {
  const input = $('admin-verifikator-name');
  const name = input?.value.trim();
  if (!name) { toast('Nama verifikator tidak boleh kosong.', 'warn'); return; }
  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/admin/verifikators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, added_by: _currentUserEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'unknown error', 'err', { title: 'Gagal tambah verifikator' }); return; }
    input.value = '';
    await renderVerifikatorList();
    renderAdminAuditLog();
  } catch (e) {
    toast('Periksa koneksi internet lalu coba lagi.', 'err', { title: 'Gagal terhubung ke server' });
  }
}

async function deleteVerifikator(id, name) {
  const yakin = await confirmDialog(
    `Hapus verifikator "${name}"?`,
    'Riwayat verifikasi yang sudah tercatat atas nama ini TIDAK ikut terhapus — dokumen akreditasi tetap utuh. ' +
    'Nama ini hanya tidak akan muncul lagi sebagai pilihan saat mengisi verifikasi baru.',
    { okText: 'Ya, hapus', danger: true }
  );
  if (!yakin) return;
  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/admin/verifikators/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removed_by: _currentUserEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'unknown error', 'err', { title: 'Gagal hapus verifikator' }); return; }
    await renderVerifikatorList();
    renderAdminAuditLog();
  } catch (e) {
    toast('Periksa koneksi internet lalu coba lagi.', 'err', { title: 'Gagal terhubung ke server' });
  }
}

async function renderAdminAuditLog() {
  const tbody = $('admin-audit-tbody');
  if (!tbody) return;
  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/admin/audit-log?limit=50');
    const logs = res.ok ? await res.json() : [];
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--muted-2);">Belum ada perubahan tercatat.</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => {
      const time = l.timestamp ? new Date(l.timestamp).toLocaleString('id-ID', { hour12: false }) : '—';
      const detailStr = l.detail ? JSON.stringify(l.detail) : '—';
      const safeDetail = detailStr.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return `<tr style="border-bottom:1px solid var(--hair);">
        <td style="padding:8px 14px;white-space:nowrap;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);">${time}</td>
        <td style="padding:8px 14px;font-weight:600;">${l.action || '—'}</td>
        <td style="padding:8px 14px;color:var(--muted);font-size:11.5px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${safeDetail}">${safeDetail}</td>
        <td style="padding:8px 14px;">${l.changed_by || '—'}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--crit);">Gagal memuat log perubahan.</td></tr>';
  }
}

// ── HALAMAN KEPATUHAN / REKAP BULANAN ───────────────────────────────────────────
// Digitalisasi formulir pencatatan manual RSND (Permenkes RI No. 72/2016):
// verifikasi 3x/hari (Pagi/Siang/Malam) dengan tanda tangan digital, grafik ala
// form kertas asli (grid tanggal 1-31, garis batas min/max), dan export PDF.
let kepatuhanChartTemp = null, kepatuhanChartHum = null;
let _kepatuhanEntries = [];
let _sigDrawing = false, _sigHasContent = false, _sigLastX = 0, _sigLastY = 0;

function _populateKepatuhanRoomFilter() {
  const sel = $('kepatuhan-room');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = ROOM_CONFIG.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  if (prev) sel.value = prev;

  // Ganti ruangan berarti sensornya lain — nilai lama harus diganti, bukan
  // dibiarkan. Kalau tidak, angka ruangan A bisa tersimpan atas nama ruangan B.
  if (!sel.dataset.listenerAttached) {
    sel.dataset.listenerAttached = '1';
    sel.addEventListener('change', () => {
      if (State.currentPage === 'kepatuhan') ambilNilaiSensor();
    });
  }
}

async function _populateVerifikatorDropdown() {
  const sel = $('kepatuhan-verifikator');
  if (!sel) return;
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/verifikators');
    const items = res.ok ? await res.json() : [];
    sel.innerHTML = '<option value="">— Pilih nama —</option>' +
      items.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  } catch (e) {
    console.warn('[Verifikator]', e.message);
  }
}

// ── ISI OTOMATIS DARI SENSOR ──────────────────────────────────────────────────
// Perawat tidak perlu lagi mengetik angka: kolom suhu & kelembapan diisi dari
// pembacaan sensor terkini, tinggal pilih nama lalu tanda tangan.
//
// Tapi angkanya TETAP bisa diubah. Ini bukan kelonggaran yang tidak perlu —
// kalau sensor rusak atau petugas mengukur dengan alat lain, angka manual harus
// tetap bisa dimasukkan. Yang penting, asal angkanya tercatat jujur di laporan.

let _sumberNilai = 'manual';        // 'sensor' selama nilai belum disentuh petugas
let _nilaiSensorTerakhir = null;    // untuk mendeteksi apakah petugas mengubahnya

const _IKON_SUMBER = {
  ok:    '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  warn:  '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z"/>',
  err:   '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  tulis: '<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>',
};

function _setKotakSumber(jenis, teks, warna, bg) {
  const box = $('kepatuhan-sumber-box');
  if (!box) return;
  box.style.display    = 'flex';
  box.style.background = bg;
  box.style.color      = warna;
  box.style.border     = '1px solid ' + warna;
  const ikon = $('kepatuhan-sumber-ikon');
  if (ikon) { ikon.innerHTML = _IKON_SUMBER[jenis] || _IKON_SUMBER.tulis; ikon.style.color = warna; }
  const t = $('kepatuhan-sumber-teks');
  if (t) t.innerHTML = teks;
}

/** Tandai bahwa nilai sekarang diketik petugas, bukan lagi dari sensor. */
function _tandaiManual() {
  if (_sumberNilai === 'manual') return;
  _sumberNilai = 'manual';
  _setKotakSumber('tulis',
    'Nilai <strong>diubah manual</strong> oleh petugas. Akan dicatat sebagai entri manual di laporan.',
    'var(--amber)', 'var(--amber-soft)');
}

/**
 * Ambil pembacaan sensor terkini dan isikan ke form.
 * @param {boolean} diminta true kalau dipicu tombol (tampilkan toast), false saat otomatis
 */
async function ambilNilaiSensor(diminta = false) {
  const deviceId = $('kepatuhan-room')?.value;
  const inpT = $('kepatuhan-temp'), inpH = $('kepatuhan-hum');
  if (!deviceId || !inpT || !inpH) return;

  _setKotakSumber('warn', 'Mengambil pembacaan sensor…', 'var(--muted)', 'var(--bg-2)');

  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/reading-now?device_id=' + encodeURIComponent(deviceId));
    const d = await res.json().catch(() => ({}));

    if (!res.ok) {
      _sumberNilai = 'manual';
      _setKotakSumber('err', 'Gagal menghubungi server. Isi suhu dan kelembapan secara manual.',
                      'var(--crit)', 'var(--crit-soft)');
      return;
    }

    // Sensor mati atau belum pernah kirim: JANGAN diisi diam-diam dengan angka lama.
    // Angka basi yang tampak resmi jauh lebih berbahaya daripada kolom kosong.
    if (!d.usable) {
      inpT.value = ''; inpH.value = '';
      _sumberNilai = 'manual';
      _nilaiSensorTerakhir = null;
      _setKotakSumber('err',
        escHtml(d.message || 'Sensor tidak tersedia.') +
        ' Entri ini akan dicatat sebagai <strong>manual</strong>.',
        'var(--crit)', 'var(--crit-soft)');
      return;
    }

    inpT.value = d.temperature;
    inpH.value = d.humidity;
    _sumberNilai = 'sensor';
    _nilaiSensorTerakhir = { t: String(d.temperature), h: String(d.humidity) };

    const jam = new Date(d.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (d.status === 'stale') {
      _setKotakSumber('warn',
        `Terisi dari sensor, pembacaan pukul <strong>${jam}</strong>. ${escHtml(d.message)}`,
        'var(--amber)', 'var(--amber-soft)');
    } else {
      _setKotakSumber('ok',
        `Terisi otomatis dari sensor, pembacaan pukul <strong>${jam}</strong>. ` +
        'Periksa sekilas, lalu pilih nama dan tanda tangan.',
        'var(--emerald)', 'var(--emerald-soft)');
    }
    if (diminta) toast('Nilai diperbarui dari sensor.', 'ok');

  } catch (e) {
    _sumberNilai = 'manual';
    _setKotakSumber('err', 'Tidak bisa terhubung ke server. Isi suhu dan kelembapan secara manual.',
                    'var(--crit)', 'var(--crit-soft)');
  }
}
window.ambilNilaiSensor = ambilNilaiSensor;

async function loadKepatuhanPage() {
  const monthInput = $('kepatuhan-month');
  if (monthInput && !monthInput.value) {
    const now = new Date();
    monthInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }
  const roomSel = $('kepatuhan-room');
  if (roomSel && !roomSel.value && ROOM_CONFIG.length) roomSel.value = ROOM_CONFIG[0].id;

  _initSignaturePad();
  _pasangPemantauUbahNilai();
  await _populateVerifikatorDropdown();
  ambilNilaiSensor();      // isi otomatis begitu halaman dibuka
  fetchKepatuhanData();
}

/**
 * Pantau apakah petugas mengubah angka yang tadinya dari sensor.
 *
 * Ini yang membuat catatan "dari sensor" bisa dipercaya: begitu satu digit pun
 * diubah, entri langsung berpindah status jadi manual. Tanpa ini, angka yang
 * sudah diedit tetap mengaku berasal dari sensor — dan itu catatan yang keliru.
 */
function _pasangPemantauUbahNilai() {
  ['kepatuhan-temp', 'kepatuhan-hum'].forEach(id => {
    const el = $(id);
    if (!el || el.dataset.pantauInit) return;
    el.dataset.pantauInit = '1';
    el.addEventListener('input', () => {
      if (_sumberNilai !== 'sensor' || !_nilaiSensorTerakhir) return;
      const t = $('kepatuhan-temp')?.value, h = $('kepatuhan-hum')?.value;
      if (t !== _nilaiSensorTerakhir.t || h !== _nilaiSensorTerakhir.h) _tandaiManual();
    });
  });
}

async function fetchKepatuhanData() {
  const deviceId = $('kepatuhan-room')?.value;
  const monthVal = $('kepatuhan-month')?.value;
  if (!deviceId || !monthVal) return;
  const [year, month] = monthVal.split('-').map(Number);
  const room = ROOM_CONFIG.find(r => r.id === deviceId) || { name: deviceId, tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 };

  setText('kepatuhan-chart-title-temp', room.name + ' — ' + monthVal);
  setText('kepatuhan-chart-title-hum',  room.name + ' — ' + monthVal);

  const tbody = $('kepatuhan-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted-2);">Memuat…</td></tr>';

  try {
    const url = CONFIG.API_BASE_URL + '/api/verifications?device_id=' + encodeURIComponent(deviceId) + '&year=' + year + '&month=' + month;
    const res = await authFetch(url);

    // JANGAN telan error jadi array kosong. Sebelumnya kegagalan server
    // (index Firestore belum dibuat, backend tidur, dsb) tampil persis sama
    // dengan "belum ada data" — mustahil didiagnosa. Sekarang dibedakan tegas.
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      _kepatuhanEntries = [];
      renderKepatuhanCharts([], room);
      _showKepatuhanError(payload.error || ('Server membalas HTTP ' + res.status));
      return;
    }

    const payload = await res.json();
    _cancelKepatuhanRetry();   // berhasil — hentikan polling "menunggu index"
    _kepatuhanEntries = payload.data || [];
    renderKepatuhanCharts(_kepatuhanEntries, room);
    renderKepatuhanTable(_kepatuhanEntries);
  } catch (e) {
    console.warn('[Kepatuhan]', e.message);
    _kepatuhanEntries = [];
    renderKepatuhanCharts([], room);
    _showKepatuhanError('Tidak bisa terhubung ke server. Backend Render mungkin sedang bangun dari mode tidur — tunggu ~40 detik lalu klik Tampilkan lagi.');
  }
}

/**
 * Tampilkan kegagalan apa adanya, lengkap dengan tebakan penyebab yang paling
 * sering terjadi, supaya bisa langsung ditindak tanpa buka console browser.
 */
function _showKepatuhanError(rawMessage) {
  const tbody = $('kepatuhan-tbody');
  if (!tbody) return;
  const msg = String(rawMessage || 'Kesalahan tidak diketahui');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Firestore menyelipkan URL console di pesan errornya. Pisahkan dari teks agar
  // bisa jadi tautan yang benar-benar bisa diklik, bukan URL panjang mentah yang
  // merusak tata letak.
  const urlMatch = msg.match(/https:\/\/console\.firebase\.google\.com\/\S+/);
  const consoleUrl = urlMatch ? urlMatch[0] : null;
  const msgClean = consoleUrl ? msg.replace(consoleUrl, '').trim() : msg;

  let title = 'Gagal memuat data verifikasi.';
  let hint = '';
  let tone = 'var(--crit)';

  if (/currently building|is building/i.test(msg)) {
    // Ini BUKAN kegagalan konfigurasi — index sudah didaftarkan dan sedang dibangun.
    // Menyuruh deploy ulang di sini justru menyesatkan.
    tone = 'var(--amber)';
    title = 'Index Firestore sedang dibangun — tunggu sebentar.';
    hint = 'Deploy index sudah berhasil. Firestore masih menyiapkannya (biasanya 2–10 menit ' +
           'untuk koleksi kecil). Tidak ada yang perlu diperbaiki — cukup tunggu lalu klik ' +
           '<strong>Tampilkan</strong> lagi. Halaman ini juga akan mencoba ulang otomatis tiap 30 detik.';
    _scheduleKepatuhanRetry();
  } else if (/requires an index|failed_precondition/i.test(msg)) {
    hint = 'Composite index Firestore untuk koleksi <code>verifications</code> belum terdaftar. ' +
           'Jalankan <code>firebase deploy --only firestore:indexes</code> dari folder proyek, ' +
           'atau klik tautan di bawah untuk membuatnya langsung.';
  } else if (/not connected|503/i.test(msg)) {
    hint = 'Backend tidak terhubung ke Firestore. Cek variabel <code>FIREBASE_SERVICE_ACCOUNT_JSON</code> ' +
           'di dashboard Render.';
  }

  const isi =
    '<strong style="color:' + tone + ';">' + title + '</strong>' +
    (hint ? '<br><span style="color:var(--muted);font-size:12.5px;">' + hint + '</span>' : '') +
    (consoleUrl
      ? '<br><a href="' + esc(consoleUrl) + '" target="_blank" rel="noopener noreferrer" ' +
        'style="display:inline-block;margin-top:8px;font-size:12.5px;color:var(--sky);text-decoration:underline;">' +
        'Buka status index di Firebase Console →</a>'
      : '') +
    '<br><span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--muted-2);' +
    'display:inline-block;margin-top:8px;word-break:break-word;">' + esc(msgClean) + '</span>';

  tbody.innerHTML =
    '<tr><td colspan="8" style="padding:20px 24px;text-align:left;line-height:1.65;">' + isi + '</td></tr>';

  // Tampilan mobile ikut dikosongkan. Kalau tidak, kartu dari permintaan
  // sebelumnya tetap terpampang seolah datanya masih valid padahal gagal dimuat.
  const cards = $('kepatuhan-cards');
  if (cards) cards.innerHTML = '<div style="padding:16px 4px;line-height:1.65;font-size:13px;">' + isi + '</div>';
}

// Coba ulang otomatis selama index masih dibangun, supaya tidak perlu menunggu
// sambil menebak-nebak kapan siap. Berhenti sendiri begitu berhasil.
let _kepatuhanRetryTimer = null;
function _scheduleKepatuhanRetry() {
  if (_kepatuhanRetryTimer) return;
  _kepatuhanRetryTimer = setInterval(() => {
    if (State.currentPage !== 'kepatuhan') return;   // jangan poll kalau user pindah halaman
    fetchKepatuhanData();
  }, 30000);
}
function _cancelKepatuhanRetry() {
  if (!_kepatuhanRetryTimer) return;
  clearInterval(_kepatuhanRetryTimer);
  _kepatuhanRetryTimer = null;
}

function _buildKepatuhanChart(canvasEl, labels, data, pointColors, minVal, maxVal, unit) {
  return new Chart(canvasEl.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Nilai', data, borderColor: '#DC2626', backgroundColor: 'transparent', borderWidth: 1.5,
          pointRadius: 3, pointBackgroundColor: pointColors, pointBorderColor: pointColors, tension: 0.15, spanGaps: true },
        { label: 'Batas Min', data: labels.map(() => minVal), borderColor: '#94a3b8', borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false },
        { label: 'Batas Max', data: labels.map(() => maxVal), borderColor: '#94a3b8', borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { boxWidth: 12, font: { family: 'JetBrains Mono', size: 10 }, color: '#888' } },
        tooltip: {
          backgroundColor: '#1c1c1e', borderColor: '#3a3a3c', borderWidth: 1, titleColor: '#a1a1aa', bodyColor: '#f4f4f5',
          callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y + (unit || '') },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(128,128,128,0.12)' }, ticks: { font: { family: 'JetBrains Mono', size: 9 }, color: '#888' } },
        y: { grid: { color: 'rgba(128,128,128,0.12)' }, ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#888', callback: v => v + (unit || '') } },
      },
    },
  });
}

/** labels dibuat "{tanggal}{P/S/M}" persis format kolom form kertas RSND (Pagi/Siang/Malam per hari) */
function renderKepatuhanCharts(entries, room) {
  const shiftLetter = { Pagi: 'P', Siang: 'S', Malam: 'M' };
  const labels = entries.map(e => {
    const d = new Date(e.submitted_at);
    return d.getDate() + (shiftLetter[e.shift] || '?');
  });
  // Titik hitam = dalam batas, merah = di luar batas — meniru tinta merah di form
  // kertas RSND. Grafik suhu diwarnai berdasarkan status SUHU saja, grafik
  // kelembapan berdasarkan status KELEMBAPAN saja. Sebelumnya keduanya memakai
  // penanda gabungan, sehingga titik pada grafik suhu bisa merah gara-gara
  // kelembapannya yang menyimpang — menyesatkan saat dibaca auditor.
  const tempColors = entries.map(e => _entryStatus(e).tempOk ? '#18181B' : '#DC2626');
  const humColors  = entries.map(e => _entryStatus(e).humOk  ? '#18181B' : '#DC2626');

  if (kepatuhanChartTemp) { kepatuhanChartTemp.destroy(); kepatuhanChartTemp = null; }
  if (kepatuhanChartHum)  { kepatuhanChartHum.destroy();  kepatuhanChartHum  = null; }

  const tempCanvas = $('kepatuhan-chart-temp');
  const humCanvas   = $('kepatuhan-chart-hum');
  if (tempCanvas) kepatuhanChartTemp = _buildKepatuhanChart(tempCanvas, labels, entries.map(e => e.temperature), tempColors, room.tempMin, room.tempMax, '°C');
  if (humCanvas)  kepatuhanChartHum  = _buildKepatuhanChart(humCanvas,  labels, entries.map(e => e.humidity),    humColors,  room.humMin,  room.humMax,  '%');
}

/**
 * Status satu entri verifikasi — suhu dan kelembapan dinilai TERPISAH.
 *
 * Backend sudah mengirim temp_in_range/hum_in_range (termasuk hasil hitung ulang
 * untuk entri lama). Kalau karena suatu hal field itu tidak ada, dihitung lagi
 * di sini dari threshold ruangan supaya tampilan tidak pernah jatuh kembali ke
 * penanda gabungan yang menyesatkan.
 */
function _entryStatus(e) {
  const room = ROOM_CONFIG.find(r => r.id === e.device_id) ||
               ROOM_CONFIG.find(r => r.id === $('kepatuhan-room')?.value) || {};
  const tempMin = room.tempMin != null ? room.tempMin : 15;
  const tempMax = room.tempMax != null ? room.tempMax : 25;
  const humMin  = room.humMin  != null ? room.humMin  : 45;
  const humMax  = room.humMax  != null ? room.humMax  : 55;

  const tempOk = (e.temp_in_range != null)
    ? !!e.temp_in_range
    : (typeof e.temperature === 'number' && e.temperature >= tempMin && e.temperature <= tempMax);
  const humOk = (e.hum_in_range != null)
    ? !!e.hum_in_range
    : (typeof e.humidity === 'number' && e.humidity >= humMin && e.humidity <= humMax);

  return { tempOk, humOk, tempMin, tempMax, humMin, humMax };
}

/**
 * Versi kartu dari riwayat verifikasi — dipakai di layar < 768px.
 *
 * Di HP, tabel 8 kolom memaksa geser jauh ke kanan hanya untuk mencapai tombol
 * Ralat; perawat hampir pasti tidak akan menemukannya. Kartu menampilkan satu
 * entri utuh tanpa geser sama sekali, dengan tombol Ralat selebar penuh.
 *
 * Dirender dari array `entries` yang SAMA dengan tabel, jadi keduanya mustahil
 * menampilkan isi yang berbeda.
 */
function renderKepatuhanCards(entries) {
  const wrap = $('kepatuhan-cards');
  if (!wrap) return;

  if (!entries.length) {
    wrap.innerHTML =
      '<p style="padding:18px 4px;font-size:13px;color:var(--muted);line-height:1.7;">' +
        '<strong style="color:var(--ink);">Belum ada verifikasi bulan ini.</strong><br>' +
        'Pastikan sudah ada verifikator terdaftar di Admin → Setting, lalu isi form di atas.' +
      '</p>';
    return;
  }

  wrap.innerHTML = entries.slice().reverse().map(e => {
    const d       = new Date(e.submitted_at);
    const dateStr = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    const st      = _entryStatus(e);

    const nilai = (baru, asli, unit, ok) => {
      const angka = baru != null ? baru.toFixed(1) : '—';
      const coret = (e.corrected && asli != null && asli !== baru)
        ? `<span class="old">${asli.toFixed(1)}${unit}</span>` : '';
      return `<span class="vcard-num" style="color:${ok ? 'var(--emerald)' : 'var(--crit)'};">${coret}${angka}${unit}</span>`;
    };

    const badgeRalat = e.corrected
      ? '<span style="padding:1px 6px;border-radius:5px;font-size:9.5px;font-weight:700;background:var(--amber-soft);color:var(--amber);">RALAT</span>'
      : '';
    const badgeManual = (e.sumber_nilai === 'manual')
      ? '<span style="padding:1px 5px;border-radius:5px;font-size:9px;font-weight:700;background:var(--bg-2);color:var(--muted);border:1px solid var(--hair);">MANUAL</span>'
      : '';

    const sig = e.signature
      ? `<img src="${e.signature}" alt="Tanda tangan ${escHtml(e.verifikator_name || '')}" class="vcard-sig js-sig-zoom" data-sig="${escHtml(e.id)}">`
      : '<span style="font-size:12px;color:var(--muted-2);">tanpa TTD</span>';

    return `<div class="vcard ${(st.tempOk && st.humOk) ? '' : 'deviasi'}">
      <div class="vcard-head">
        <span class="vcard-shift">${escHtml(e.shift)} ${badgeRalat} ${badgeManual}</span>
        <span class="vcard-date">${dateStr}</span>
      </div>
      <div class="vcard-vals">
        <div class="vcard-val">
          <span class="label">Suhu</span>
          ${nilai(e.temperature, e.original_temperature, '°C', st.tempOk)}
          <span class="vcard-status" style="color:${st.tempOk ? 'var(--emerald)' : 'var(--crit)'};">${st.tempOk ? 'Dalam batas' : 'Di luar ' + st.tempMin + '–' + st.tempMax + '°C'}</span>
        </div>
        <div class="vcard-val">
          <span class="label">Kelembapan</span>
          ${nilai(e.humidity, e.original_humidity, '%', st.humOk)}
          <span class="vcard-status" style="color:${st.humOk ? 'var(--emerald)' : 'var(--crit)'};">${st.humOk ? 'Dalam batas' : 'Di luar ' + st.humMin + '–' + st.humMax + '%'}</span>
        </div>
      </div>
      <div class="vcard-meta">
        <span class="vcard-who">${escHtml(e.verifikator_name || '—')}</span>
        ${sig}
      </div>
      ${e.catatan ? `<p class="vcard-note"><strong>Catatan:</strong> ${escHtml(e.catatan)}</p>` : ''}
      ${e.tindakan ? `<p class="vcard-note"><strong>Tindakan:</strong> ${escHtml(e.tindakan)}</p>` : ''}
      ${e.corrected
        ? `<p class="vcard-note" style="color:var(--amber);"><strong>Diralat:</strong> ${escHtml(e.correction_reason || '')}</p>`
        : `<button class="btn-ghost btn-koreksi-verifikasi vcard-ralat" data-id="${escHtml(e.id)}">Ralat entri ini</button>`}
    </div>`;
  }).join('');
}

function renderKepatuhanTable(entries) {
  renderKepatuhanCards(entries);   // versi mobile dirender berdampingan, dari data yang sama

  const tbody = $('kepatuhan-tbody');
  if (!tbody) return;
  if (!entries.length) {
    // Empty state yang mengajari, bukan cuma memberi tahu. Penyebab paling sering
    // di awal pemakaian: daftar verifikator masih kosong sehingga form tidak
    // bisa disubmit sama sekali.
    tbody.innerHTML =
      '<tr><td colspan="8" style="padding:22px 24px;text-align:left;line-height:1.7;color:var(--muted);">' +
        '<strong style="color:var(--ink);">Belum ada verifikasi untuk bulan ini.</strong><br>' +
        'Untuk mulai mengisi: pastikan sudah ada nama verifikator terdaftar di ' +
        '<strong>Admin → Setting</strong>, lalu isi form di bawah (shift, suhu, kelembaban, ' +
        'nama verifikator, tanda tangan) dan klik Simpan Verifikasi. ' +
        'Sesuai Permenkes 72/2016 diisi 3× sehari: Pagi 07.00, Siang 14.00, Malam 22.00.' +
      '</td></tr>';
    return;
  }
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  tbody.innerHTML = entries.slice().reverse().map((e, i) => {
    const d = new Date(e.submitted_at);
    const dateStr = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

    // Suhu dan kelembapan dinilai SENDIRI-SENDIRI. Sebelumnya kedua kolom
    // memakai satu warna dari `in_range` gabungan, sehingga entri 23°C / 34%
    // membuat kolom suhu ikut merah padahal 23°C normal — perawat tidak bisa
    // tahu mana yang sebenarnya perlu ditindak.
    const st = _entryStatus(e);
    const tempColor = st.tempOk ? 'var(--emerald)' : 'var(--crit)';
    const humColor  = st.humOk  ? 'var(--emerald)' : 'var(--crit)';
    // Latar baris dibuat lebih lembut dan hanya sebagai penanda halus. Dengan
    // latar merah penuh, tabel yang banyak deviasinya jadi merah semua dan
    // warnanya kehilangan arti.
    // Zebra halus agar mata mudah mengikuti baris sampai ke kolom paling kanan;
    // baris deviasi diberi rona merah tipis yang menimpanya.
    const zebra = (i % 2 === 1) ? 'background:var(--bg-2);' : '';
    const rowBg = (st.tempOk && st.humOk) ? zebra : 'background:color-mix(in srgb, var(--crit) 5%, transparent);';

    // Tanda tangan diperbesar sedikit dan bisa diklik untuk dilihat penuh —
    // ukuran 26px mustahil diperiksa keabsahannya dengan mata.
    const sig = e.signature
      ? `<img src="${e.signature}" alt="Tanda tangan ${esc(e.verifikator_name || '')}" class="js-sig-zoom"
              data-sig="${esc(e.id)}" title="Klik untuk memperbesar"
              style="height:32px;background:#fff;border-radius:3px;border:1px solid var(--hair);cursor:zoom-in;display:block;" />`
      : '<span style="color:var(--muted-2);">—</span>';
    const catatan = esc(e.catatan || '—');

    // Nilai yang sudah diralat ditampilkan seperti pada formulir kertas: angka
    // lama dicoret, angka baru di sebelahnya. Auditor bisa melihat riwayatnya
    // langsung tanpa harus membuka database.
    const withOriginal = (nilai, asli, unit) => {
      const baru = nilai != null ? nilai.toFixed(1) + unit : '—';
      if (!e.corrected || asli == null || asli === nilai) return baru;
      return `<span style="text-decoration:line-through;color:var(--muted-2);font-weight:400;">${asli.toFixed(1)}${unit}</span> ${baru}`;
    };

    const tandaKoreksi = e.corrected
      ? `<span title="Dikoreksi ${esc(e.corrected_by || '')}: ${esc(e.correction_reason || '')}"
              style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:5px;font-size:9.5px;font-weight:700;
                     background:var(--amber-soft);color:var(--amber);vertical-align:middle;">RALAT</span>`
      : '';

    // Entri yang angkanya diketik tangan dibedakan dari yang terisi otomatis.
    // Auditor perlu tahu mana yang berasal dari alat dan mana dari pengukuran
    // manual — keduanya sah, tapi artinya berbeda.
    const tandaManual = (e.sumber_nilai === 'manual')
      ? `<span title="Suhu &amp; kelembapan diisi manual oleh petugas, bukan dari sensor"
              style="display:inline-block;margin-left:5px;padding:1px 5px;border-radius:5px;font-size:9px;font-weight:700;
                     background:var(--bg-2);color:var(--muted);border:1px solid var(--hair);vertical-align:middle;">MANUAL</span>`
      : '';

    return `<tr style="border-bottom:1px solid var(--hair);${rowBg}">
      <td style="padding:7px 12px;white-space:nowrap;">${dateStr}</td>
      <td style="padding:7px 12px;white-space:nowrap;">${esc(e.shift)}${tandaKoreksi}${tandaManual}</td>
      <td style="padding:7px 12px;text-align:right;font-weight:600;color:${tempColor};white-space:nowrap;" title="${st.tempOk ? 'Dalam batas' : 'Di luar batas ' + st.tempMin + '–' + st.tempMax + '°C'}">${withOriginal(e.temperature, e.original_temperature, '°C')}</td>
      <td style="padding:7px 12px;text-align:right;font-weight:600;color:${humColor};white-space:nowrap;" title="${st.humOk ? 'Dalam batas' : 'Di luar batas ' + st.humMin + '–' + st.humMax + '%'}">${withOriginal(e.humidity, e.original_humidity, '%')}</td>
      <td style="padding:7px 12px;">${esc(e.verifikator_name || '—')}</td>
      <td style="padding:7px 12px;">${sig}</td>
      <td style="padding:7px 12px;color:var(--muted);max-width:180px;">
        ${(e.catatan || e.tindakan)
          ? `<button class="js-lihat-catatan" data-id="${esc(e.id)}" title="Lihat catatan lengkap"
                     style="all:unset;cursor:pointer;display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;
                            white-space:nowrap;color:var(--muted);border-bottom:1px dotted var(--muted-2);">${catatan}</button>`
          : '<span style="color:var(--muted-2);">—</span>'}
      </td>
      <td style="padding:7px 12px;text-align:right;white-space:nowrap;">
        ${e.corrected
          ? '<span style="font-size:11px;color:var(--muted-2);">sudah diralat</span>'
          : `<button class="btn-ghost btn-koreksi-verifikasi" data-id="${esc(e.id)}"
                     style="font-size:11.5px;padding:4px 10px;">Ralat</button>`}
      </td>
    </tr>`;
  }).join('');
}

/** Tampilkan tanda tangan ukuran penuh — supaya keabsahannya bisa diperiksa. */
function lihatTandaTangan(id) {
  const e = _kepatuhanEntries.find(x => x.id === id);
  if (!e || !e.signature) { toast('Entri ini tidak punya tanda tangan tersimpan.', 'warn'); return; }
  const tgl = new Date(e.submitted_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  showModal({
    title: 'Tanda tangan ' + (e.verifikator_name || '—'),
    sub: `${e.shift} · ${tgl}`,
    bodyHtml: `<img src="${escHtml(e.signature)}" alt="Tanda tangan ukuran penuh" class="sig-zoom-img">`,
    okText: 'Tutup',
    hideCancel: true,
  });
}
window.lihatTandaTangan = lihatTandaTangan;

/** Tampilkan catatan & tindakan lengkap satu entri. */
function lihatCatatanVerifikasi(id) {
  const e = _kepatuhanEntries.find(x => x.id === id);
  if (!e) { toast('Entri tidak ditemukan.', 'err'); return; }
  const tgl = new Date(e.submitted_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });

  const blok = (judul, isi) => isi
    ? `<div style="margin-bottom:14px;">
         <span class="label" style="display:block;margin-bottom:4px;">${judul}</span>
         <p style="margin:0;font-size:13.5px;line-height:1.65;color:var(--ink-2);white-space:pre-wrap;word-break:break-word;">${escHtml(isi)}</p>
       </div>`
    : '';

  showModal({
    title: `Catatan ${e.shift}`,
    sub: `${e.room_name || ''} · ${tgl} · ${e.verifikator_name || '—'}`,
    bodyHtml:
      (blok('Catatan / Analisis', e.catatan) || '') +
      (blok('Tindakan & Hasil', e.tindakan) || '') +
      (e.corrected ? blok('Alasan ralat', e.correction_reason) : '') +
      ((!e.catatan && !e.tindakan)
        ? '<p style="margin:0;font-size:13px;color:var(--muted);">Tidak ada catatan pada entri ini.</p>' : ''),
    okText: 'Tutup',
    hideCancel: true,
  });
}
window.lihatCatatanVerifikasi = lihatCatatanVerifikasi;

/**
 * Ralat satu entri verifikasi lewat SATU modal.
 *
 * Versi sebelumnya memakai tiga prompt() beruntun. Itu keliru: kalau petugas
 * membatalkan di dialog ketiga, dua isian sebelumnya hilang percuma; nilai lama
 * tidak bisa ditampilkan berdampingan sehingga orang mengoreksi sambil menghafal;
 * dan di HP kotak sistem itu muncul menempel di atas keyboard.
 *
 * Modal ini menampilkan nilai lama (dicoret) tepat di sebelah kolom isian baru,
 * memvalidasi saat mengetik, dan tidak kehilangan apa pun sampai benar-benar
 * disimpan.
 */
async function koreksiVerifikasi(id) {
  const entry = _kepatuhanEntries.find(e => e.id === id);
  if (!entry) { toast('Entri tidak ditemukan. Muat ulang halaman lalu coba lagi.', 'err'); return; }

  const tgl = new Date(entry.submitted_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  const st  = _entryStatus(entry);
  const inputStyle = "width:100%;font-size:15px;font-family:'JetBrains Mono',monospace;padding:8px 10px;height:auto;text-align:center;";

  const hasil = await showModal({
    title: `Ralat verifikasi ${entry.shift}`,
    sub: `${escHtml(entry.room_name || '')} · ${tgl} · diverifikasi ${escHtml(entry.verifikator_name || '-')}`,
    okText: 'Simpan ralat',
    cancelText: 'Batal',
    bodyHtml:
      '<div class="ralat-grid">' +
        '<div class="ralat-cell">' +
          '<span class="label">Suhu tercatat</span>' +
          `<span class="ralat-old">${entry.temperature != null ? entry.temperature.toFixed(1) : '—'}°C</span>` +
        '</div>' +
        '<div>' +
          '<label class="label" for="ralat-temp" style="display:block;margin-bottom:5px;">Suhu yang benar (°C)</label>' +
          `<input type="number" step="0.1" inputmode="decimal" id="ralat-temp" class="input" style="${inputStyle}" value="${entry.temperature != null ? entry.temperature : ''}">` +
        '</div>' +
        '<div class="ralat-cell">' +
          '<span class="label">Kelembapan tercatat</span>' +
          `<span class="ralat-old">${entry.humidity != null ? entry.humidity.toFixed(1) : '—'}%</span>` +
        '</div>' +
        '<div>' +
          '<label class="label" for="ralat-hum" style="display:block;margin-bottom:5px;">Kelembapan yang benar (%)</label>' +
          `<input type="number" step="0.1" inputmode="decimal" id="ralat-hum" class="input" style="${inputStyle}" value="${entry.humidity != null ? entry.humidity : ''}">` +
        '</div>' +
      '</div>' +
      '<label class="label" for="ralat-alasan" style="display:block;margin-bottom:5px;">Alasan koreksi <span style="color:var(--crit);">*</span></label>' +
      '<textarea id="ralat-alasan" class="input" rows="2" style="width:100%;font-size:13.5px;padding:8px 10px;height:auto;resize:vertical;" ' +
        'placeholder="Contoh: Salah ketik saat input, angka 3 dan 5 tertukar."></textarea>' +
      '<div class="modal-err" id="ralat-err"></div>' +
      `<p style="margin:12px 0 0;font-size:12px;color:var(--muted);line-height:1.6;padding:10px 12px;background:var(--amber-soft);border-radius:9px;">` +
        `Nilai lama <strong>tidak dihapus</strong>. Angka ${entry.temperature}°C / ${entry.humidity}% tetap tersimpan dan akan tampil dicoret ` +
        `di tabel maupun PDF, sesuai kaidah koreksi dokumen akreditasi. Ralat hanya bisa dilakukan sekali.` +
      `</p>`,

    onOpen: (box) => {
      const t = box.querySelector('#ralat-temp');
      if (t) { t.focus(); t.select(); }
      // Sembunyikan pesan error begitu petugas mulai memperbaiki isian.
      const err = box.querySelector('#ralat-err');
      box.querySelectorAll('#ralat-temp, #ralat-hum, #ralat-alasan').forEach(el => {
        el.addEventListener('input', () => err && err.classList.remove('show'));
      });
    },

    // Validasi terpusat: kembalikan string = tampilkan error & modal tetap terbuka.
    validate: (box) => {
      const suhu   = parseFloat(box.querySelector('#ralat-temp').value);
      const hum    = parseFloat(box.querySelector('#ralat-hum').value);
      const alasan = box.querySelector('#ralat-alasan').value.trim();

      if (Number.isNaN(suhu) || Number.isNaN(hum)) return 'Suhu dan kelembapan harus diisi angka.';
      if (suhu < 5 || suhu > 45)   return 'Suhu di luar batas kewajaran ruangan (5–45°C). Periksa lagi.';
      if (hum < 10 || hum > 100)   return 'Kelembapan di luar batas kewajaran (10–100%). Periksa lagi.';
      if (alasan.length < 5)       return 'Alasan koreksi wajib diisi, minimal 5 karakter.';
      if (suhu === entry.temperature && hum === entry.humidity) {
        return 'Nilainya belum berubah. Ubah suhu atau kelembapan dulu, atau batalkan.';
      }
      return { temperature: suhu, humidity: hum, alasan };
    },
  });

  if (!hasil || hasil === true) return;   // dibatalkan

  try {
    const res = await authFetch(CONFIG.API_BASE_URL + '/api/verifications/' + encodeURIComponent(id) + '/correct', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...hasil, corrected_by: _currentUserEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'unknown error', 'err', { title: 'Gagal menyimpan ralat' }); return; }
    toast(`${entry.shift} ${tgl} kini tercatat ${hasil.temperature}°C / ${hasil.humidity}%. Nilai lama tetap tersimpan.`,
          'ok', { title: 'Ralat tersimpan' });
    fetchKepatuhanData();
  } catch (e) {
    toast('Periksa koneksi internet lalu coba lagi.', 'err', { title: 'Gagal terhubung ke server' });
  }
}
window.koreksiVerifikasi = koreksiVerifikasi;

// ── Signature pad (canvas, mouse + touch) ──────────────────────────────────────

/**
 * Samakan resolusi buffer canvas dengan ukurannya di layar.
 *
 * PENTING: tingginya diambil dari ukuran RENDER sebenarnya, bukan angka tetap.
 * Di HP CSS membesarkan pad jadi 190px (jari butuh ruang lebih lega daripada
 * mouse); kalau buffer tetap dipatok 150, koordinat gambar akan meleset dari
 * posisi jari — tanda tangan muncul bergeser ke atas.
 */
function _resizeSignaturePad(canvas, ctx) {
  const rect  = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);

  canvas.width  = w * ratio;
  canvas.height = h * ratio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);   // buang transform lama sebelum skala baru
  ctx.scale(ratio, ratio);
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = '#111';
}

function _initSignaturePad() {
  const canvas = $('kepatuhan-signature-pad');
  if (!canvas || canvas.dataset.sigInit) return;
  canvas.dataset.sigInit = '1';
  const ctx = canvas.getContext('2d');

  _resizeSignaturePad(canvas, ctx);

  // Mengubah ukuran canvas MENGHAPUS isinya, jadi hanya dilakukan saat pad masih
  // kosong. Kalau petugas sudah menandatangani lalu memutar layar, biarkan
  // gambarnya utuh — lebih baik sedikit meleset daripada hilang tanpa pemberitahuan.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!_sigHasContent) _resizeSignaturePad(canvas, ctx);
    }, 200);
  });

  const getPos = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); _sigDrawing = true; _sigHasContent = true; const p = getPos(e); _sigLastX = p.x; _sigLastY = p.y; };
  const move  = (e) => {
    if (!_sigDrawing) return;
    e.preventDefault();
    const p = getPos(e);
    ctx.beginPath(); ctx.moveTo(_sigLastX, _sigLastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    _sigLastX = p.x; _sigLastY = p.y;
  };
  const end = () => { _sigDrawing = false; };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
}

function clearSignaturePad() {
  const canvas = $('kepatuhan-signature-pad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  _sigHasContent = false;
}
window.clearSignaturePad = clearSignaturePad;

function getSignatureDataURL() {
  const canvas = $('kepatuhan-signature-pad');
  if (!canvas || !_sigHasContent) return null;
  return canvas.toDataURL('image/png');
}

async function submitKepatuhanVerification() {
  const msgEl = $('kepatuhan-submit-msg');
  const setMsg = (text, color) => { if (msgEl) { msgEl.textContent = text; msgEl.style.color = color || 'var(--muted)'; } };

  const deviceId      = $('kepatuhan-room')?.value;
  const shift          = $('kepatuhan-shift')?.value;
  const temp           = parseFloat($('kepatuhan-temp')?.value);
  const hum            = parseFloat($('kepatuhan-hum')?.value);
  const verifikatorId  = $('kepatuhan-verifikator')?.value;
  const catatan        = $('kepatuhan-catatan')?.value || '';
  const tindakan       = $('kepatuhan-tindakan')?.value || '';
  const signature      = getSignatureDataURL();

  if (!deviceId)                        { setMsg('Pilih ruangan dulu.', 'var(--crit)'); return; }
  if (Number.isNaN(temp) || Number.isNaN(hum)) { setMsg('Isi suhu dan kelembaban dengan angka.', 'var(--crit)'); return; }
  if (!verifikatorId)                   { setMsg('Pilih nama verifikator.', 'var(--crit)'); return; }
  if (!signature)                       { setMsg('Tanda tangan wajib diisi.', 'var(--crit)'); return; }

  // Ingatkan kalau jam pengisian jauh dari jam shift resmi. Bukan menolak —
  // keterlambatan wajar terjadi saat ruangan sedang sibuk. Yang penting petugas
  // sadar bahwa angka sensor yang terisi adalah angka SEKARANG, bukan angka jam
  // shift tersebut, sehingga tidak mengira sedang mencatat keadaan beberapa jam lalu.
  const JAM_SHIFT = { Pagi: 7, Siang: 14, Malam: 22 };
  const sekarang = new Date();
  const selisihJam = Math.abs(sekarang.getHours() + sekarang.getMinutes() / 60 - JAM_SHIFT[shift]);
  if (selisihJam > 3 && selisihJam < 21) {   // <21 supaya Malam 22.00 diisi 01.00 tidak salah hitung
    const lanjut = await confirmDialog(
      `Mengisi shift ${shift} di luar jamnya`,
      `Shift ${shift} dijadwalkan pukul ${String(JAM_SHIFT[shift]).padStart(2, '0')}.00, ` +
      `sedangkan sekarang pukul ${sekarang.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}.\n\n` +
      (_sumberNilai === 'sensor'
        ? 'Angka yang terisi adalah pembacaan sensor SAAT INI, bukan pembacaan pada jam shift tersebut.'
        : 'Pastikan angka yang diisi memang hasil pengukuran pada shift tersebut.'),
      { okText: 'Ya, tetap simpan', cancelText: 'Batal' }
    );
    if (!lanjut) { setMsg('Dibatalkan.', 'var(--amber)'); return; }
  }

  const btn = $('btn-kepatuhan-submit');
  const kirim = async (allowExtreme) => {
    return authFetch(CONFIG.API_BASE_URL + '/api/verifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId, shift, verifikator_id: verifikatorId,
        temperature: temp, humidity: hum, signature, catatan, tindakan,
        allow_extreme: !!allowExtreme,
        // Asal angka ikut dikirim, tapi backend tetap mencocokkannya dengan
        // pembacaan sensor sungguhan sebelum mempercayainya.
        sumber_nilai: _sumberNilai,
      }),
    });
  };

  if (btn) btn.disabled = true;
  setMsg('Menyimpan…');

  try {
    let res  = await kirim(false);
    let data = await res.json().catch(() => ({}));

    // 422 = nilai di luar batas kewajaran fisik (mis. 3°C di ruang bersalin).
    // Bukan langsung ditolak: bisa jadi memang begitu kondisinya. Tanyakan dulu,
    // lalu kirim ulang dengan penegasan kalau petugas yakin.
    if (res.status === 422 && data.reason === 'implausible_value') {
      const lanjut = await confirmDialog(
        'Nilai di luar batas kewajaran',
        data.error + '\n\nKalau angka ini memang benar-benar terbaca di alat ukur, lanjutkan menyimpan. ' +
        'Kalau ragu, batalkan dan periksa lagi isiannya.',
        { okText: 'Angka sudah benar, simpan', cancelText: 'Perbaiki dulu' }
      );
      if (!lanjut) { setMsg('Dibatalkan — perbaiki nilainya lalu simpan lagi.', 'var(--amber)'); return; }
      setMsg('Menyimpan…');
      res  = await kirim(true);
      data = await res.json().catch(() => ({}));
    }

    // 409 = shift ini sudah pernah diisi hari ini. Jangan cuma bilang gagal —
    // arahkan ke jalur yang benar, yaitu meralat entri yang sudah ada.
    if (res.status === 409 && data.reason === 'duplicate_shift') {
      setMsg(data.error, 'var(--crit)');
      if (data.existing_id) {
        const keRalat = await confirmDialog(
          'Shift ini sudah diisi hari ini',
          data.error + '\n\nBuka form ralat untuk entri tersebut sekarang?',
          { okText: 'Buka form ralat', cancelText: 'Nanti saja' }
        );
        if (keRalat) {
          // Entri duplikat selalu bertanggal HARI INI. Kalau tabel sedang
          // menampilkan bulan lain, entri itu tidak ada di _kepatuhanEntries —
          // pindahkan dulu tampilannya ke bulan berjalan supaya ketemu.
          const now = new Date();
          const bulanIni = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
          if ($('kepatuhan-month') && $('kepatuhan-month').value !== bulanIni) {
            $('kepatuhan-month').value = bulanIni;
          }
          await fetchKepatuhanData();
          koreksiVerifikasi(data.existing_id);
        }
      }
      return;
    }

    if (!res.ok) { setMsg('Gagal: ' + (data.error || 'unknown error'), 'var(--crit)'); return; }

    // Backend bisa MENURUNKAN klaim 'sensor' jadi 'manual' kalau angkanya tidak
    // cocok dengan pembacaan sungguhan. Beri tahu petugas kalau itu terjadi,
    // supaya tidak mengira entrinya tercatat sebagai otomatis.
    if (_sumberNilai === 'sensor' && data.sumber_nilai === 'manual') {
      toast('Angka tidak cocok dengan pembacaan sensor, jadi dicatat sebagai entri manual.',
            'warn', { title: 'Tersimpan sebagai manual' });
      setMsg('✓ Tersimpan (dicatat manual).', 'var(--amber)');
    } else {
      setMsg('✓ Verifikasi tersimpan.', 'var(--emerald)');
    }

    if ($('kepatuhan-catatan'))  $('kepatuhan-catatan').value = '';
    if ($('kepatuhan-tindakan')) $('kepatuhan-tindakan').value = '';
    clearSignaturePad();
    // Isi ulang dari sensor untuk shift berikutnya, alih-alih mengosongkan kolom.
    // Kalau dikosongkan, petugas harus mengetik lagi — persis yang mau dihindari.
    ambilNilaiSensor();
    fetchKepatuhanData();
  } catch (e) {
    setMsg('Gagal terhubung ke server.', 'var(--crit)');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ══ PDF REPLIKA FORMULIR KERTAS RSND ═════════════════════════════════════════
// Menggantikan grafik Chart.js pada PDF lama. RSND meminta laporan yang bentuknya
// SAMA dengan formulir tulis tangan mereka: kertas berpetak dengan 3 kolom shift
// per tanggal, titik dihubungkan garis tinta merah, blok merah penanda hari
// Minggu, baris paraf petugas di bawah grafik, kotak keterangan 5 butir, dan
// tabel analisis untuk diisi tangan.
//
// Digambar sebagai SVG murni, bukan Chart.js, karena bentuk ini bertentangan
// dengan asumsi pustaka grafik: sumbu X harus SELALU menampilkan semua tanggal
// (terisi maupun kosong), latarnya petak penuh, dan ada baris paraf di dalam
// area grafik. Memaksakan Chart.js ke bentuk ini lebih rumit dan lebih rapuh
// daripada menggambar sendiri.
//
// Satuan viewBox = milimeter. A4 lanskap margin 8 mm -> area cetak 281 x 194 mm.

const _BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
                   'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/**
 * Rentang sumbu Y. Keputusan RSND: sumbu mengikuti data (nilai 30 °C harus tetap
 * tergambar), TAPI garis batas standar (15/25 atau 45/55) selalu dipaksa masuk —
 * tanpa acuan itu pembaca kehilangan patokan mana yang normal.
 * Kalau rentang melebar melewati 16 baris, langkah dinaikkan 2 -> 4 supaya petak
 * tidak menjadi rapat tak terbaca.
 */
function _hitungSumbuY(values, forceLo, forceHi) {
  let step = 2;
  const dataLo = values.length ? Math.min(...values) : forceLo;
  const dataHi = values.length ? Math.max(...values) : forceHi;
  let lo = Math.floor(Math.min(forceLo, dataLo) / step) * step;
  let hi = Math.ceil(Math.max(forceHi, dataHi) / step) * step;
  if (lo === Math.min(forceLo, dataLo)) lo -= step;   // sisakan 1 baris ruang di tepi
  if (hi === Math.max(forceHi, dataHi)) hi += step;
  if ((hi - lo) / step > 16) {
    step = 4;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
  }
  return { lo, hi, step };
}

/**
 * Satu blok grafik formulir (suhu ATAU kelembapan) sebagai SVG utuh.
 *
 * o = {
 *   judul       : 'GRAFIK MONITORING SUHU'
 *   unit        : '°' | '%'
 *   lo, hi, step: hasil _hitungSumbuY
 *   tLo, tHi    : batas standar (garis merah putus-putus)
 *   days        : jumlah hari bulan itu
 *   sundays     : Set tanggal yang jatuh hari Minggu
 *   points      : Map colIdx -> { v: nilai, ok: dalam batas? }
 *   paraf       : Map colIdx -> dataURL tanda tangan TERPOTONG (siap cetak kecil)
 * }
 */
function _bangunGrafikFormulir(o) {
  const LABEL_W = 16, GRID_W = 265, W = LABEL_W + GRID_W;
  const nCol = o.days * 3;
  const colW = GRID_W / nCol;
  const dateW = colW * 3;

  const HDR_DATE = 5, HDR_SHIFT = 4, HDR = HDR_DATE + HDR_SHIFT;
  const rows = Math.round((o.hi - o.lo) / o.step);
  // Batas bawah 2.8 mm dipilih dari hitungan halaman: dengan dua grafik yang
  // sama-sama ekstrem (16 baris), 3.2 mm membuat halaman luber 9 mm melewati
  // area cetak A4; 2.8 mm menyisakan ruang 10 mm dan petaknya masih terbaca.
  const rowH = Math.min(6, Math.max(2.8, 44 / rows));
  const gridH = rows * rowH;
  const PARAF_H = 8;
  const H = HDR + gridH + PARAF_H + 1;

  const X = (c) => LABEL_W + c * colW;          // tepi kiri kolom shift ke-c
  const Y = (v) => HDR + ((o.hi - v) / (o.hi - o.lo)) * gridH;   // nilai -> posisi

  const s = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
         `font-family="Arial, Helvetica, sans-serif">`);

  // ── Blok merah hari Minggu ─────────────────────────────────────────────────
  // Keputusan RSND: blok merah = penanda hari Minggu (bukan libur — data tetap
  // dicatat). Karena murni kalender, blok digambar dari tanggal, bukan dari
  // data, sehingga tetap muncul walau hari itu belum diisi.
  for (const d of o.sundays) {
    s.push(`<rect x="${X((d - 1) * 3).toFixed(2)}" y="0" width="${dateW.toFixed(2)}" ` +
           `height="${(HDR + gridH + PARAF_H).toFixed(2)}" fill="#F5B8B8"/>`);
  }

  // ── Petak ──────────────────────────────────────────────────────────────────
  for (let r = 0; r <= rows; r++) {
    const y = (HDR + r * rowH).toFixed(2);
    s.push(`<line x1="${LABEL_W}" y1="${y}" x2="${W}" y2="${y}" stroke="#8A8A8A" stroke-width="0.09"/>`);
  }
  for (let c = 0; c <= nCol; c++) {
    const tebal = c % 3 === 0;   // batas antar tanggal lebih tegas
    s.push(`<line x1="${X(c).toFixed(2)}" y1="0" x2="${X(c).toFixed(2)}" ` +
           `y2="${(HDR + gridH + PARAF_H).toFixed(2)}" stroke="${tebal ? '#555' : '#B5B5B5'}" ` +
           `stroke-width="${tebal ? 0.2 : 0.08}"/>`);
  }

  // Garis tepi header & baris paraf
  for (const y of [0, HDR_DATE, HDR, HDR + gridH, HDR + gridH + PARAF_H]) {
    s.push(`<line x1="${LABEL_W}" y1="${y.toFixed(2)}" x2="${W}" y2="${y.toFixed(2)}" stroke="#333" stroke-width="0.25"/>`);
  }
  s.push(`<line x1="${LABEL_W}" y1="0" x2="${LABEL_W}" y2="${(HDR + gridH + PARAF_H).toFixed(2)}" stroke="#333" stroke-width="0.25"/>`);

  // ── Kepala kolom: tanggal + P/S/M ──────────────────────────────────────────
  s.push(`<text x="${LABEL_W - 1.2}" y="3.4" font-size="2.3" text-anchor="end" font-weight="bold">Tgl</text>`);
  s.push(`<text x="${LABEL_W - 1.2}" y="${HDR - 1.2}" font-size="2" text-anchor="end">Shift</text>`);
  const SH = ['P', 'S', 'M'];
  for (let d = 1; d <= o.days; d++) {
    s.push(`<text x="${(X((d - 1) * 3) + dateW / 2).toFixed(2)}" y="3.6" font-size="2.4" ` +
           `text-anchor="middle" font-weight="bold">${d}</text>`);
    for (let k = 0; k < 3; k++) {
      s.push(`<text x="${(X((d - 1) * 3 + k) + colW / 2).toFixed(2)}" y="${HDR - 1.1}" ` +
             `font-size="1.6" text-anchor="middle" fill="#444">${SH[k]}</text>`);
    }
  }

  // ── Label sumbu Y + garis batas standar ────────────────────────────────────
  for (let v = o.lo; v <= o.hi; v += o.step) {
    const ambang = (v === o.tLo || v === o.tHi);
    s.push(`<text x="${LABEL_W - 1.2}" y="${(Y(v) + 0.85).toFixed(2)}" font-size="2.3" ` +
           `text-anchor="end"${ambang ? ' font-weight="bold" fill="#B91C1C"' : ''}>${v}${o.unit}</text>`);
  }
  // Batas standar digambar putus-putus merah. Formulir kertas tidak memerlukannya
  // karena sumbunya PAS di batas; sumbu kita mengikuti data (keputusan RSND),
  // jadi batasnya harus ditandai eksplisit agar tetap terbaca.
  for (const v of [o.tLo, o.tHi]) {
    if (v >= o.lo && v <= o.hi) {
      s.push(`<line x1="${LABEL_W}" y1="${Y(v).toFixed(2)}" x2="${W}" y2="${Y(v).toFixed(2)}" ` +
             `stroke="#B91C1C" stroke-width="0.22" stroke-dasharray="1.4 0.9"/>`);
    }
  }

  // ── Garis merah + titik ────────────────────────────────────────────────────
  // Meniru keterangan formulir butir 3: "tarik garis dari hari sebelumnya hingga
  // membuat satu garis (menggunakan tinta merah)".
  const cols = [...o.points.keys()].sort((a, b) => a - b);
  if (cols.length > 1) {
    const pts = cols.map(c => `${(X(c) + colW / 2).toFixed(2)},${Y(o.points.get(c).v).toFixed(2)}`).join(' ');
    s.push(`<polyline points="${pts}" fill="none" stroke="#CC1111" stroke-width="0.4" ` +
           `stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  for (const c of cols) {
    const p = o.points.get(c);
    s.push(`<circle cx="${(X(c) + colW / 2).toFixed(2)}" cy="${Y(p.v).toFixed(2)}" r="0.75" ` +
           `fill="${p.ok ? '#111' : '#CC1111'}"/>`);
  }

  // ── Baris paraf ────────────────────────────────────────────────────────────
  // Keputusan RSND: tanda tangan diperkecil sampai seukuran paraf tulis tangan.
  // Hasilnya memang coretan kecil yang tidak terbaca satu per satu — sama seperti
  // formulir asli; fungsinya penanda kehadiran, bukan untuk dibaca. Versi ukuran
  // normal tetap ada di daftar paraf bawah halaman.
  s.push(`<text x="${LABEL_W - 1.2}" y="${(HDR + gridH + 3.4).toFixed(2)}" font-size="1.8" ` +
         `text-anchor="end">Nama</text>`);
  s.push(`<text x="${LABEL_W - 1.2}" y="${(HDR + gridH + 6).toFixed(2)}" font-size="1.8" ` +
         `text-anchor="end">Paraf</text>`);
  const py = HDR + gridH + 0.6, ph = PARAF_H - 1.2;
  for (const [c, url] of o.paraf) {
    // Lebar dibiarkan sampai 3 kolom (selebar 1 tanggal) — paraf asli di kertas
    // juga meluber melewati kolomnya sendiri; preserveAspectRatio menjaga bentuk.
    const pw = dateW;
    const px = X(c) + colW / 2 - pw / 2;
    s.push(`<image x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${pw.toFixed(2)}" ` +
           `height="${ph.toFixed(2)}" preserveAspectRatio="xMidYMid meet" href="${url}"/>`);
  }

  s.push('</svg>');
  return s.join('\n');
}

/** Potong kanvas tanda tangan ke area yang benar-benar bertinta.
 *  Kebanyakan orang menandatangani hanya di sebagian kanvas 420x150; tanpa
 *  pemotongan, rasio kosong itu ikut diperkecil dan parafnya jadi tak terlihat. */
function _cropTandaTangan(dataURL) {
  return new Promise((resolve) => {
    if (!dataURL) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            if (data[(y * c.width + x) * 4 + 3] > 20) {   // piksel bertinta
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) { resolve(dataURL); return; }   // kanvas kosong — pakai apa adanya
        const pad = 6;
        minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
        maxX = Math.min(c.width - 1, maxX + pad); maxY = Math.min(c.height - 1, maxY + pad);
        const w = maxX - minX + 1, h = maxY - minY + 1;
        const c2 = document.createElement('canvas');
        c2.width = w; c2.height = h;
        c2.getContext('2d').drawImage(c, minX, minY, w, h, 0, 0, w, h);
        resolve(c2.toDataURL('image/png'));
      } catch (e) { resolve(dataURL); }
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

async function exportKepatuhanPDF() {
  if (!_kepatuhanEntries.length) {
    showModal({
      title: 'Belum ada data untuk diekspor',
      sub: 'Laporan dibuat dari entri verifikasi shift, bukan dari data sensor otomatis.',
      bodyHtml:
        '<ol style="margin:0;padding-left:20px;font-size:13.5px;line-height:1.75;color:var(--ink-2);">' +
          '<li><strong>Admin → Setting</strong> — tambahkan minimal 1 nama verifikator.</li>' +
          '<li>Isi form verifikasi: shift, suhu, kelembapan, nama, tanda tangan.</li>' +
          '<li>Klik <strong>Simpan Verifikasi</strong>. Ulangi tiap shift — Pagi, Siang, Malam.</li>' +
        '</ol>',
      okText: 'Mengerti', hideCancel: true,
    });
    return;
  }

  const room     = ROOM_CONFIG.find(r => r.id === $('kepatuhan-room')?.value);
  const roomName = room ? room.name : ($('kepatuhan-room')?.value || '—');
  const monthVal = $('kepatuhan-month')?.value || '';
  const [year, month] = monthVal.split('-').map(Number);
  const days = new Date(year, month, 0).getDate();

  // Hari Minggu bulan itu — dihitung dari kalender, bukan dari data.
  const sundays = new Set();
  for (let d = 1; d <= days; d++) {
    if (new Date(year, month - 1, d).getDay() === 0) sundays.add(d);
  }

  // Petakan entri ke kolom (tanggal-1)*3 + shift, dan potong semua tanda tangan.
  const SIDX = { Pagi: 0, Siang: 1, Malam: 2 };
  const tPts = new Map(), hPts = new Map(), paraf = new Map();
  const tVals = [], hVals = [];
  const perluCrop = [];

  for (const e of _kepatuhanEntries) {
    const d = new Date(e.submitted_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    const col = (d.getDate() - 1) * 3 + (SIDX[e.shift] ?? 0);
    const st = _entryStatus(e);
    if (typeof e.temperature === 'number') { tPts.set(col, { v: e.temperature, ok: st.tempOk }); tVals.push(e.temperature); }
    if (typeof e.humidity === 'number')    { hPts.set(col, { v: e.humidity,    ok: st.humOk  }); hVals.push(e.humidity); }
    if (e.signature) perluCrop.push([col, e.signature]);
  }

  toast('Menyiapkan laporan…', 'info', { duration: 2500 });
  for (const [col, sig] of perluCrop) paraf.set(col, await _cropTandaTangan(sig));

  const limits = room || { tempMin: 15, tempMax: 25, humMin: 45, humMax: 55 };
  const tAxis = _hitungSumbuY(tVals, limits.tempMin, limits.tempMax);
  const hAxis = _hitungSumbuY(hVals, limits.humMin,  limits.humMax);

  const svgSuhu = _bangunGrafikFormulir({
    judul: 'GRAFIK MONITORING SUHU', unit: '°',
    lo: tAxis.lo, hi: tAxis.hi, step: tAxis.step,
    tLo: limits.tempMin, tHi: limits.tempMax,
    days, sundays, points: tPts, paraf,
  });
  const svgHum = _bangunGrafikFormulir({
    judul: 'GRAFIK MONITORING KELEMBABAN', unit: '%',
    lo: hAxis.lo, hi: hAxis.hi, step: hAxis.step,
    tLo: limits.humMin, tHi: limits.humMax,
    days, sundays, points: hPts, paraf,
  });

  // Daftar paraf ukuran normal — paraf mini di grid tidak terbaca satu per satu
  // (memang seperti kertas asli); daftar ini yang membuatnya tetap bisa diperiksa.
  const verifikatorUnik = new Map();
  for (const e of _kepatuhanEntries) {
    if (e.verifikator_name && e.signature && !verifikatorUnik.has(e.verifikator_name)) {
      verifikatorUnik.set(e.verifikator_name, e.signature);
    }
  }
  const daftarParaf = [...verifikatorUnik].map(([nama, sig]) =>
    `<div style="display:flex;align-items:center;gap:2mm;">
       <img src="${sig}" style="height:9mm;border-bottom:0.3mm solid #999;">
       <span style="font-size:2.6mm;">${escHtml(nama)}</span>
     </div>`).join('');

  // Tabel analisis: entri menyimpang / yang punya catatan, + baris kosong tulis tangan.
  const barisAnalisis = _kepatuhanEntries
    .filter(e => { const st = _entryStatus(e); return !(st.tempOk && st.humOk) || e.catatan || e.tindakan; })
    .map(e => {
      const d = new Date(e.submitted_at);
      const st = _entryStatus(e);
      return `<tr>
        <td>${d.getDate()}/${month} ${escHtml(e.shift)}</td>
        <td><span style="color:${st.tempOk ? '#111' : '#CC1111'};">${e.temperature != null ? e.temperature.toFixed(1) : '—'}°C</span> /
            <span style="color:${st.humOk ? '#111' : '#CC1111'};">${e.humidity != null ? e.humidity.toFixed(1) : '—'}%</span>
            ${e.sumber_nilai === 'manual' ? '<sup>M</sup>' : ''}${e.corrected ? '<sup style="color:#B45309;">R</sup>' : ''}</td>
        <td>${escHtml(e.catatan || '')}</td>
        <td>${escHtml(e.tindakan || '')}</td>
        <td>${escHtml(e.verifikator_name || '')}</td>
      </tr>`;
    }).join('');
  const barisKosong = '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>'.repeat(5);

  const w = window.open('', '_blank', 'width=1200,height=800');
  if (!w) { toast('Pop-up diblokir browser. Izinkan pop-up untuk situs ini lalu coba lagi.', 'err'); return; }

  w.document.write(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>Monitoring ${escHtml(roomName)} — ${_BULAN_ID[month - 1]} ${year}</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  .pg { width: 281mm; page-break-after: always; }
  .pg:last-child { page-break-after: auto; }
  svg { display: block; width: 281mm; height: auto; }
  .kop { display: flex; align-items: center; justify-content: space-between;
         border-bottom: 0.6mm solid #111; padding-bottom: 1.5mm; margin-bottom: 2mm; }
  .kop .logo { font-size: 5mm; font-weight: bold; color: #0B7A43; }
  .kop .judul { text-align: center; }
  .kop .judul h1 { font-size: 4.2mm; }
  .kop .judul p { font-size: 2.8mm; color: #333; }
  .kop .bulan { font-size: 3mm; text-align: right; line-height: 1.6; }
  .lbl { font-size: 3mm; font-weight: bold; margin: 1.5mm 0 0.5mm; }
  .bawah { display: flex; gap: 4mm; margin-top: 2mm; }
  .ket { flex: 1.4; border: 0.3mm solid #333; padding: 2mm; font-size: 2.5mm; line-height: 1.55; }
  .ket ol { padding-left: 4mm; }
  .parafbox { flex: 1; border: 0.3mm solid #333; padding: 2mm; }
  .parafbox .isi { display: flex; flex-wrap: wrap; gap: 2mm 5mm; margin-top: 1mm; }
  h2 { font-size: 4mm; margin-bottom: 2mm; }
  table.analisis { width: 100%; border-collapse: collapse; font-size: 3mm; }
  table.analisis th, table.analisis td { border: 0.25mm solid #333; padding: 1.6mm 2mm; text-align: left; vertical-align: top; }
  table.analisis th { background: #EFEFEF; font-size: 2.7mm; text-transform: uppercase; }
  table.analisis td { height: 9mm; }
  .ttd { display: flex; justify-content: flex-end; gap: 30mm; margin-top: 8mm; text-align: center; font-size: 3mm; }
  .ttd .garis { margin-top: 18mm; border-top: 0.3mm solid #111; padding-top: 1mm; }
  .np { position: fixed; top: 4mm; right: 4mm; padding: 2.5mm 5mm; background: #111; color: #fff;
        border: none; border-radius: 2mm; font-size: 3.2mm; cursor: pointer; }
  @media print { .np { display: none; } }
</style></head><body>

<button class="np" onclick="window.print()">⬇ Print / Save PDF</button>

<div class="pg">
  <div class="kop">
    <div class="logo">✚ RSND</div>
    <div class="judul">
      <h1>GRAFIK MONITORING SUHU DAN KELEMBABAN RUANGAN</h1>
      <p>${escHtml(roomName)} · Permenkes RI No. 72 Tahun 2016 (suhu ${limits.tempMin}–${limits.tempMax} °C, kelembaban ${limits.humMin}–${limits.humMax}%)</p>
    </div>
    <div class="bulan">BULAN : <strong>${_BULAN_ID[month - 1].toUpperCase()}</strong><br>TAHUN : <strong>${year}</strong></div>
  </div>

  <div class="lbl">GRAFIK MONITORING SUHU</div>
  ${svgSuhu}
  <div class="lbl">GRAFIK MONITORING KELEMBABAN</div>
  ${svgHum}

  <div class="bawah">
    <div class="ket">
      <strong>KETERANGAN :</strong>
      <ol>
        <li>Ketentuan : batas normal suhu penyimpanan ${limits.tempMin}–${limits.tempMax} °C, kelembaban udara ${limits.humMin}–${limits.humMax}% (Permenkes RI No. 72 Tahun 2016)</li>
        <li>Titik dibubuhkan pada kolom suhu dan kelembaban pada tanggal yang sesuai setiap shift Pagi, Siang, Malam</li>
        <li>Garis ditarik dari hari sebelumnya hingga membentuk satu garis (tinta merah)</li>
        <li>Nama dan paraf petugas tercantum pada kolom petugas; kolom bertanda merah adalah hari Minggu (data tetap dicatat)</li>
        <li>Jika suhu berada di luar batas normal, petugas segera menghubungi IPSRS</li>
      </ol>
      <p style="margin-top:1mm;color:#555;">Titik merah = di luar batas · <sup>M</sup> = diisi manual · <sup>R</sup> = entri diralat (nilai asli tersimpan)</p>
    </div>
    <div class="parafbox">
      <strong style="font-size:2.7mm;">NAMA &amp; PARAF PETUGAS BULAN INI</strong>
      <div class="isi">${daftarParaf || '<span style="font-size:2.6mm;color:#777;">—</span>'}</div>
    </div>
  </div>
</div>

<div class="pg">
  <h2>ANALISIS &amp; TINDAK LANJUT — ${escHtml(roomName)}, ${_BULAN_ID[month - 1]} ${year}</h2>
  <table class="analisis">
    <thead><tr>
      <th style="width:14%;">Tgl / Shift</th>
      <th style="width:16%;">Suhu / Kelembaban</th>
      <th style="width:28%;">Analisis</th>
      <th style="width:28%;">Tindakan dan Hasil</th>
      <th style="width:14%;">Petugas yg Melaporkan</th>
    </tr></thead>
    <tbody>${barisAnalisis}${barisKosong}</tbody>
  </table>
  <div class="ttd">
    <div>Petugas<div class="garis">(&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;)</div></div>
    <div>Mengetahui,<br>Kepala Ruangan<div class="garis">(&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;)</div></div>
  </div>
</div>

</body></html>`);
  w.document.close();
}

/**
 * Masuk ke tampilan detail 1 ruangan (gauge, grafik, compare, stats) dari kartu overview.
 * Menggantikan switchRoom()/opsi "Semua" lama — dashboard sekarang SELALU spesifik 1 ruangan
 * begitu masuk ke detail, tidak ada lagi query tanpa device_id yang datanya ambigu.
 */
function selectRoomDetail(roomId) {
  if (!roomId) return;
  State.selectedRoom = roomId;

  const room = ROOM_CONFIG.find(r => r.id === roomId);
  setText('dashboard-detail-room-name', room ? room.name : roomId);
  _renderBateraiDetail(roomId);

  $('dashboard-overview').style.display = 'none';
  $('dashboard-detail').style.display = '';
  $('dashboard-room-switcher').style.display = 'flex';

  // Reset gauge ke "—" seketika agar tidak tampilkan data sisa ruangan sebelumnya
  resetGauges();
  fetchLatest();
  fetchDashChart();
  fetchStats();
}
window.selectRoomDetail = selectRoomDetail;

/** Kembali ke grid overview semua ruangan. */
function backToOverview() {
  State.selectedRoom = null;
  $('dashboard-detail').style.display = 'none';
  $('dashboard-room-switcher').style.display = 'none';
  $('dashboard-overview').style.display = '';
  resetGauges();
}
window.backToOverview = backToOverview;

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
  setText('footer-year', String(new Date().getFullYear()));  // dulu ditulis tetap di HTML
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
let _currentUserEmail = 'Internal Staff'; // dipakai sebagai 'changed_by' di audit log admin

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
  closeMoreSheet();                       // jangan tinggalkan sheet mobile terbuka di atas layar login
  document.body.style.overflow = '';      // pulihkan scroll kalau sheet sempat mengunci
  $('login-screen').style.display = 'flex';
  document.querySelector('.app-shell').style.display = 'none';
  if ($('sidebar-user')) $('sidebar-user').style.display = 'none';
  const bnav = document.querySelector('.bottom-nav');
  if (bnav) bnav.style.display = 'none';  // bottom nav tidak boleh mengambang di layar login

  // Kosongkan field sandi supaya tidak tertinggal di perangkat bersama.
  if ($('login-pass')) $('login-pass').value = '';
  if ($('login-error')) $('login-error').style.display = 'none';
}

function showApp(mode, user=null) {
  currentMode = mode;
  $('login-screen').style.display = 'none';
  document.querySelector('.app-shell').style.display = 'flex';

  // Bottom nav dikembalikan ke kendali CSS (hanya tampil di bawah 1024px).
  // showLogin() menyembunyikannya lewat inline style, jadi harus dibersihkan.
  const bnav = document.querySelector('.bottom-nav');
  if (bnav) bnav.style.display = '';

  if (mode === 'publik') {
    if ($('public-banner')) $('public-banner').style.display = 'block';

    // Hide extra navs
    $$('.sidebar-nav .nav-item').forEach(btn => {
      if (btn.dataset.page && btn.dataset.page !== 'dashboard') {
        btn.style.display = 'none';
      }
    });
    // Mode publik: hanya Dashboard. Sembunyikan juga entri mobile-nya, kalau
    // tidak, halaman internal tetap bisa dibuka dari HP lewat bottom nav/sheet.
    $$('.bnav-item[data-page]').forEach(btn => {
      btn.style.display = btn.dataset.page === 'dashboard' ? 'flex' : 'none';
    });
    if ($('bnav-more')) $('bnav-more').style.display = 'none';

    // Hide export/chat
    if ($('btn-export-csv')) $('btn-export-csv').style.display = 'none';
    // id tombolnya 'chat-fab-btn' (class-nya yang 'chat-fab') — sebelumnya
    // salah sasaran sehingga FAB chat tetap muncul di mode publik.
    if ($('chat-fab-btn')) $('chat-fab-btn').style.display = 'none';
    if ($('btn-notif-bell')) $('btn-notif-bell').parentElement.style.display = 'none';

    navigateTo('dashboard');
  } else {
    if ($('public-banner')) $('public-banner').style.display = 'none';
    $$('.sidebar-nav .nav-item').forEach(btn => btn.style.display = 'flex');
    $$('.bnav-item[data-page]').forEach(btn => btn.style.display = 'flex');
    if ($('bnav-more')) $('bnav-more').style.display = 'flex';
    if ($('btn-export-csv')) $('btn-export-csv').style.display = 'flex';
    if ($('chat-fab-btn')) $('chat-fab-btn').style.display = 'flex';
    if ($('btn-notif-bell')) $('btn-notif-bell').parentElement.style.display = 'block';
    _initBrowserNotif();  // prompt perawat untuk enable notifikasi browser
    _initAlarmSoundBtn(); // prompt perawat untuk enable suara alarm website

    _currentUserEmail = (user && user.email) ? user.email : 'Internal Staff';

    if ($('sidebar-user')) {
      $('sidebar-user').style.display = 'block';
      $('user-email-text').textContent = _currentUserEmail;
    }
    
    navigateTo('dashboard');
  }
}

window.showApp = showApp; // expose for public button

/** Pesan error Firebase Auth diterjemahkan ke bahasa yang dimengerti perawat. */
function _authErrorMessage(err) {
  const code = (err && err.code) || '';
  const map = {
    'auth/invalid-email':        'Format email tidak valid.',
    'auth/user-disabled':        'Akun ini dinonaktifkan. Hubungi administrator.',
    'auth/user-not-found':       'Email atau kata sandi salah.',
    'auth/wrong-password':       'Email atau kata sandi salah.',
    'auth/invalid-credential':   'Email atau kata sandi salah.',
    'auth/too-many-requests':    'Terlalu banyak percobaan gagal. Tunggu beberapa menit lalu coba lagi.',
    'auth/network-request-failed': 'Tidak ada koneksi internet. Periksa jaringan lalu coba lagi.',
  };
  return map[code] || (err && err.message) || 'Login gagal. Coba lagi.';
}

if ($('login-form')) {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email   = ($('login-email').value || '').trim();
    const pass    = $('login-pass').value || '';
    const errEl   = $('login-error');
    const submit  = $('login-form').querySelector('button[type="submit"]');
    const origLbl = submit ? submit.textContent : '';

    const showErr = (msg) => {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.style.display = 'block';
    };
    if (errEl) errEl.style.display = 'none';

    if (!email || !pass) { showErr('Email dan kata sandi wajib diisi.'); return; }

    // KEAMANAN: versi lama punya jalur fallback yang langsung meloloskan user ke
    // mode internal ketika Firebase SDK gagal dimuat — artinya siapa pun bisa
    // masuk TANPA password hanya dengan memblokir skrip Firebase. Untuk sistem
    // data rumah sakit itu tidak bisa diterima. Sekarang: kalau layanan auth
    // tidak tersedia, login DITOLAK, tidak ada jalan pintas.
    if (typeof firebase === 'undefined' || !firebase.auth) {
      showErr('Layanan autentikasi tidak dapat dimuat. Periksa koneksi internet, ' +
              'lalu muat ulang halaman. Login tidak dapat dilanjutkan tanpa verifikasi.');
      return;
    }

    if (submit) { submit.disabled = true; submit.textContent = 'Memverifikasi…'; }
    try {
      await firebase.auth().signInWithEmailAndPassword(email, pass);
      // Sukses — onAuthStateChanged yang akan memanggil showApp().
    } catch (err) {
      showErr(_authErrorMessage(err));
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = origLbl || 'Masuk'; }
    }
  });
}

/**
 * Logout terpusat — dipakai tombol sidebar (desktop) DAN sheet "Lainnya" (mobile).
 * Minta konfirmasi lebih dulu: dashboard ini sering dibiarkan terbuka di nurse
 * station, jadi logout tak sengaja berarti monitoring berhenti tampil.
 */
async function performLogout() {
  const yakin = await confirmDialog(
    'Keluar dari akun?',
    'Monitoring akan berhenti ditampilkan sampai ada yang masuk kembali. ' +
    'Sensor tetap merekam dan alarm tetap terkirim ke Telegram/Discord.',
    { okText: 'Ya, keluar', danger: true }
  );
  if (!yakin) return;
  closeMoreSheet();
  try {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      await firebase.auth().signOut();
    } else {
      showLogin();
    }
  } catch (e) {
    console.warn('[Auth] signOut gagal:', e.message);
    showLogin();
  }
}
window.performLogout = performLogout;

if ($('btn-logout')) {
  $('btn-logout').addEventListener('click', (e) => { e.preventDefault(); performLogout(); });
}
if ($('more-sheet-logout')) {
  $('more-sheet-logout').addEventListener('click', (e) => { e.preventDefault(); performLogout(); });
}
if ($('more-sheet-theme')) {
  $('more-sheet-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('climateos-theme', next); } catch (e) {}
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
    _sensorStatusTerakhir = {};   // catatan lengkap (termasuk baterai) untuk halaman detail
    data.forEach(s => {
      if (s.device_id) {
        State.sensorStatuses[s.device_id] = s.status;
        _sensorStatusTerakhir[s.device_id] = s;
      }
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

    // Peringatan di header grid ruangan. Prioritas: sensor offline lebih genting
    // daripada baterai lemah, jadi kalau keduanya terjadi, offline yang tampil.
    const offlineBanner = $('offline-warning-banner');
    if (offlineBanner) {
      const lemah = data.filter(s => s.battery_pct != null && s.battery_pct <= 20);
      if (hasOffline) {
        offlineBanner.style.display = 'flex';
        offlineBanner.style.background = 'var(--crit-soft)';
        offlineBanner.style.color = 'var(--crit)';
        setText('offline-warning-text', 'Ada sensor offline');
      } else if (lemah.length) {
        // Baterai habis berarti ruangan berhenti terpantau tanpa ada yang tahu —
        // lebih baik diperingatkan sejak 20% daripada saat sudah mati.
        offlineBanner.style.display = 'flex';
        offlineBanner.style.background = 'var(--amber-soft)';
        offlineBanner.style.color = 'var(--amber)';
        setText('offline-warning-text',
          lemah.length === 1
            ? `Baterai ${lemah[0].room_name} tinggal ${lemah[0].battery_pct}%`
            : `${lemah.length} alat baterainya lemah`);
      } else {
        offlineBanner.style.display = 'none';
      }
    }

    // Render room status grid di dashboard
    renderRoomGrid(data);

    // Pil baterai di halaman detail — ikut diperbarui tiap polling, supaya
    // angkanya tidak basi saat halaman detail dibiarkan terbuka lama.
    if (State.selectedRoom) _renderBateraiDetail(State.selectedRoom);

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
/**
 * Ubah waktu pembacaan terakhir jadi keterangan yang mudah dibaca.
 *
 * Menyebut JAM saja tidak cukup — "23:04" tidak memberi tahu apakah itu 5 menit
 * lalu atau kemarin. Menyebut selisihnya saja juga kurang, karena orang ingin
 * tahu jam pastinya untuk mencocokkan dengan kejadian di ruangan. Jadi keduanya
 * ditampilkan, kecuali kalau sudah lewat sehari (jamnya jadi tidak relevan).
 */
function _umurData(lastSeen) {
  if (!lastSeen) return 'waktu tidak tercatat';
  const t = new Date(lastSeen);
  if (isNaN(t)) return 'waktu tidak tercatat';

  const menit = Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000));
  const jam = t.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  if (menit < 1)    return `terakhir ${jam}, baru saja`;
  if (menit < 60)   return `terakhir ${jam}, ${menit} menit lalu`;
  if (menit < 1440) return `terakhir ${jam}, ${Math.floor(menit / 60)} jam lalu`;

  const hari = Math.floor(menit / 1440);
  return `terakhir ${t.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })}, ` +
         `${hari} hari lalu`;
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

    // Angka dari sensor yang sudah offline adalah pembacaan TERAKHIR sebelum
    // alat mati, bukan keadaan sekarang. Tetap ditampilkan (berguna untuk tahu
    // kondisi ruangan saat alat berhenti, kadang justru itu petunjuk penyebabnya),
    // tapi harus jelas bahwa itu bukan angka terkini — kalau tidak, ruangan yang
    // sama sekali tidak terpantau justru terlihat seolah terpantau.
    const basi = (status === 'offline' || status === 'never') && temp != null;

    if (status === 'offline' || status === 'never') {
      cardClass += ' room-offline';
      healthLabel = basi ? '— Data terakhir' : '— Tidak ada data';
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
    // Nilai basi selalu abu-abu, apa pun angkanya. Mewarnainya merah/hijau akan
    // memberi kesan penilaian atas keadaan sekarang — padahal keadaan sekarang
    // justru tidak diketahui.
    const tempColor = basi || temp == null ? 'var(--muted-2)'
      : (temp < tempMin || temp > tempMax) ? 'var(--coral)' : 'var(--emerald)';
    const humColor = basi || hum == null ? 'var(--muted-2)'
      : (hum < humMin || hum > humMax) ? 'var(--sky)' : 'var(--emerald)';

    const tempStr = temp != null ? temp.toFixed(1) + '°C' : '—';
    const humStr  = hum  != null ? hum.toFixed(1)  + '%'  : '—';
    const floor   = s.floor || room.floor || '';
    const batt    = _labelBaterai(s.battery_pct, s.battery_v);

    // Pita penanda data basi. Tanpa ini, kartu memajang angka besar sementara
    // labelnya bilang tidak ada data — perawat yang melirik sekilas akan membaca
    // angka lama sebagai keadaan sekarang, dan ruangan yang sama sekali tidak
    // terpantau justru terlihat seolah terpantau.
    const pitaBasi = basi
      ? `<div style="display:flex;align-items:center;gap:5px;margin-bottom:8px;padding:4px 8px;
                     border-radius:6px;background:var(--bg-2);border:1px solid var(--hair);">
           <svg style="width:12px;height:12px;flex-shrink:0;color:var(--muted);" fill="none"
                viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
             <circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 7v5l3 2"/>
           </svg>
           <span style="font-size:10.5px;font-weight:600;color:var(--muted);">
             Bukan data terkini · ${_umurData(s.last_seen)}
           </span>
         </div>`
      : '';

    return `<div class="${cardClass}" role="button" tabindex="0" style="cursor:pointer;" onclick="window.selectRoomDetail('${room.id}')" onkeydown="if(event.key==='Enter')window.selectRoomDetail('${room.id}')">
        <div class="room-card-header">
          <span class="room-card-name">${room.name}</span>
          ${floor ? `<span class="room-card-floor">${floor}</span>` : ''}
        </div>
        ${pitaBasi}
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
          <span style="display:flex;align-items:center;gap:8px;">
            ${batt.html}
            <span style="font-size:11px;font-weight:500;color:${conn.color};">${conn.label}</span>
          </span>
        </div>
      </div>`;
  }).join('');
}

/**
 * Label baterai untuk kartu ruangan.
 *
 * Unit tanpa modul voltage sensor mengirim null — dalam hal itu tidak ada apa pun
 * yang ditampilkan, bukan "0%". Menampilkan nol untuk perangkat yang memang tidak
 * punya sensor baterai akan terbaca sebagai baterai habis.
 */
/** Warna baterai menurut sisa daya. Ambang diturunkan dari kurva Li-ion:
 *  di bawah 20% tegangan mulai jatuh cepat, jadi itu saat yang tepat untuk
 *  mulai menyiapkan penggantian — bukan menunggu sampai benar-benar habis. */
function _warnaBaterai(pct) {
  if (pct <= 20) return 'var(--crit)';
  if (pct <= 40) return 'var(--amber)';
  return 'var(--emerald)';
}

/**
 * Ikon baterai sebagai SVG — bentuk baterai sungguhan dengan isi yang mengikuti
 * persentase.
 *
 * Versi sebelumnya memakai karakter blok (▮▯). Di banyak font karakter itu tidak
 * tersedia dan browser menggantinya dengan kotak kosong, sehingga tampil sebagai
 * "tofu" — persis yang terlihat di dashboard. SVG tidak punya masalah itu:
 * bentuknya sama di semua perangkat dan tetap tajam saat diperbesar.
 */
function _ikonBateraiSvg(pct, tinggi = 13) {
  const w = tinggi * 1.85;              // proporsi baterai mendatar
  const warna = _warnaBaterai(pct);
  // Sisa daya kecil tetap diberi lebar minimum supaya isinya masih terlihat —
  // KECUALI benar-benar 0%, yang harus tampil kosong. Tanpa pengecualian ini,
  // 0% dan 8% tampak persis sama di layar.
  const isi = pct <= 0 ? 0 : Math.max(0.08, Math.min(1, pct / 100));
  const bodyW = w * 0.82, padX = w * 0.055, padY = tinggi * 0.16;
  const dalamW = (bodyW - padX * 2) * isi;
  return `<svg width="${w.toFixed(1)}" height="${tinggi}" viewBox="0 0 ${w.toFixed(1)} ${tinggi}"
       fill="none" style="flex-shrink:0;" aria-hidden="true">
    <rect x="0.6" y="0.6" width="${(bodyW - 1.2).toFixed(1)}" height="${(tinggi - 1.2).toFixed(1)}"
          rx="${(tinggi * 0.22).toFixed(1)}" stroke="${warna}" stroke-width="1.2"/>
    <rect x="${(bodyW + 0.8).toFixed(1)}" y="${(tinggi * 0.32).toFixed(1)}"
          width="${(w - bodyW - 1.4).toFixed(1)}" height="${(tinggi * 0.36).toFixed(1)}"
          rx="${(tinggi * 0.1).toFixed(1)}" fill="${warna}"/>
    <rect x="${padX.toFixed(1)}" y="${padY.toFixed(1)}" width="${dalamW.toFixed(1)}"
          height="${(tinggi - padY * 2).toFixed(1)}" rx="${(tinggi * 0.12).toFixed(1)}" fill="${warna}"/>
  </svg>`;
}

/**
 * Label baterai untuk kartu ruangan.
 *
 * Unit tanpa modul voltage sensor mengirim null — dalam hal itu tidak ada apa pun
 * yang ditampilkan, bukan "0%". Menampilkan nol untuk perangkat yang memang tidak
 * punya sensor baterai akan terbaca sebagai baterai habis.
 */
function _labelBaterai(pct, volt) {
  if (pct == null) return { html: '', kritis: false };
  const warna = _warnaBaterai(pct);
  const judul = volt != null ? `Baterai ${pct}% (${volt.toFixed(2)} V)` : `Baterai ${pct}%`;
  return {
    kritis: pct <= 20,
    html: `<span title="${judul}" style="display:inline-flex;align-items:center;gap:4px;
                 font-size:11px;font-weight:600;color:${warna};white-space:nowrap;">
             ${_ikonBateraiSvg(pct, 12)}${pct}%
           </span>`,
  };
}

/** Pil baterai di halaman detail ruangan — lebih besar, sekaligus menampilkan tegangan. */
function _renderBateraiDetail(deviceId) {
  const el = $('detail-battery');
  if (!el) return;
  const s = _sensorStatusTerakhir[deviceId];
  const pct = s ? s.battery_pct : null;

  if (pct == null) { el.style.display = 'none'; return; }   // unit tanpa sensor baterai

  const warna = _warnaBaterai(pct);
  const volt  = s.battery_v != null ? ` · ${s.battery_v.toFixed(2)} V` : '';
  el.style.display = 'inline-flex';
  el.style.cssText += ';align-items:center;gap:6px;padding:4px 10px;border-radius:20px;' +
                      `border:1px solid ${warna};background:var(--card);`;
  el.innerHTML = `${_ikonBateraiSvg(pct, 14)}
    <span style="font-size:12px;font-weight:650;color:${warna};">${pct}%${volt}</span>` +
    (pct <= 20 ? `<span style="font-size:11px;color:${warna};">· segera ganti</span>` : '');
}
