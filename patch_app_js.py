import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    js = f.read()

# 1. Update CONFIG and add ROOM_CONFIG & FIREBASE_CONFIG
js = js.replace("const CONFIG = {", """const ROOM_CONFIG = [
  { id: "NICU-01",    name: "NICU",              floor: "Lt. 2", tempMin: 24, tempMax: 26, humMin: 50, humMax: 60 },
  { id: "BANGSAL-A",  name: "Bangsal Bayi",       floor: "Lt. 2", tempMin: 22, tempMax: 26, humMin: 45, humMax: 60 },
  { id: "BANGSAL-B",  name: "Bangsal Anak Umum",  floor: "Lt. 3", tempMin: 20, tempMax: 24, humMin: 40, humMax: 60 },
  { id: "ISOLASI-01", name: "Ruang Isolasi",       floor: "Lt. 3", tempMin: 22, tempMax: 25, humMin: 45, humMax: 55 },
];

const CONFIG = {
  FIREBASE_CONFIG: {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
  },
""")

js = js.replace("ClimateOS", "MediClimate RS")

# 2. Modify navigateTo to handle nav-bangsal
nav_bangsal = """  const pageEl = $('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  // Handle Bangsal Logic
  if (page === 'bangsal') {
    fetchBangsal();
  }
"""
js = js.replace("  const pageEl = $('page-' + page);\n  if (pageEl) pageEl.classList.add('active');", nav_bangsal)

# 3. Add Keep Alive, Auth, Bangsal, and Compliance logic at the bottom
new_logic = """
// ─── AUTHENTICATION (Login System) ──────────────────────────
let currentMode = 'public'; // 'public' | 'internal'

function initAuth() {
  try {
    firebase.initializeApp(CONFIG.FIREBASE_CONFIG);
    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        showApp('internal', user);
      } else {
        showLogin();
      }
    });
  } catch (e) {
    console.error("Firebase auth error (cek config):", e);
    // Fallback if config is dummy
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
    
    data.forEach(s => {
      if (!s.unknown) {
        if (s.status === 'online' || s.status === 'warning') onlineCount++;
        if (s.status === 'offline') hasOffline = true;
      }
    });
    
    if ($('sensor-pill-text')) {
      $('sensor-pill-text').textContent = `${onlineCount}/${ROOM_CONFIG.length} Sensor Online`;
    }
    
    if (hasOffline && $('offline-warning-banner')) {
      $('offline-warning-banner').style.display = 'flex';
    } else if ($('offline-warning-banner')) {
      $('offline-warning-banner').style.display = 'none';
    }
    
    return data;
  } catch (e) {
    console.error(e);
  }
}

// ─── BANGSAL LOGIC ───────────────────────────────────────────
async function fetchBangsal() {
  if (currentMode === 'publik') return;
  const statusData = await fetchSensorStatus() || [];
  
  // also fetch history to get latest values for all rooms
  // the app.js already fetches history, we can just use the endpoint
  let history = [];
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/api/history?range=1h');
    const hData = await res.json();
    history = hData.data || [];
  } catch (e) {}

  const grid = $('bangsal-grid');
  if (!grid) return;
  grid.innerHTML = '';
  
  ROOM_CONFIG.forEach(room => {
    // get room status
    const s = statusData.find(d => d.device_id === room.id);
    const status = s ? s.status : 'never';
    const lastSeen = s ? s.last_seen : null;
    
    // get latest history for this room
    const roomHistory = history.filter(d => d.device_id === room.id);
    const latest = roomHistory.length > 0 ? roomHistory[roomHistory.length - 1] : null;
    
    let temp = '--', hum = '--';
    let badgeText = 'OFFLINE', badgeClass = 'bg-gray-200 text-gray-700';
    let overlay = status === 'offline' ? 'opacity: 0.6; filter: grayscale(1);' : '';
    
    if (status !== 'offline' && status !== 'never' && latest) {
      temp = latest.temperature;
      hum = latest.humidity;
      
      const dTemp = Math.max(0, temp - room.tempMax, room.tempMin - temp);
      const dHum = Math.max(0, hum - room.humMax, room.humMin - hum);
      
      if (dTemp > 2 || dHum > 10) {
        badgeText = 'CRITICAL';
        badgeClass = 'bg-red-100 text-red-700 border-red-300 badge-critical';
      } else if (dTemp > 0 || dHum > 0) {
        badgeText = 'WARNING';
        badgeClass = 'bg-yellow-100 text-yellow-700 border-yellow-300';
      } else {
        badgeText = 'NORMAL';
        badgeClass = 'bg-green-100 text-green-700 border-green-300';
      }
    }
    
    const card = document.createElement('div');
    card.className = 'card-elev p-5 flex flex-col gap-3 relative';
    card.style = overlay;
    card.innerHTML = `
      <div class="flex justify-between items-start">
        <div>
          <h3 class="font-semibold text-ink">${room.name}</h3>
          <p class="text-xs text-muted-2">${room.floor} | ${room.id}</p>
        </div>
        <span class="badge ${badgeClass} text-xs px-2 py-1">${badgeText}</span>
      </div>
      <div class="flex justify-between items-end mt-2">
        <div>
          <div class="text-3xl font-bold text-ink">${temp}°C</div>
          <div class="text-sm font-medium text-muted">Hum: ${hum}%</div>
        </div>
      </div>
      <div class="text-xs text-muted mt-2 border-t border-gray-100 pt-2">
        Update: ${lastSeen || 'Belum ada data'}
      </div>
    `;
    grid.appendChild(card);
  });
}

// ─── COMPLIANCE LOGIC ────────────────────────────────────────
let compChart = null;

if ($('btn-load-compliance')) {
  $('btn-load-compliance').addEventListener('click', async () => {
    const devId = $('compliance-room').value;
    const dateStr = $('compliance-date').value;
    if (!dateStr) return alert("Pilih tanggal!");
    
    try {
      const res = await fetch(`${CONFIG.API_BASE_URL}/api/compliance?device_id=${devId}&date=${dateStr}`);
      const data = await res.json();
      
      $('compliance-result').style.display = 'block';
      $('compliance-score-text').textContent = data.compliance_score + '%';
      
      let color = 'oklch(0.60 0.13 155)'; // green
      if (data.compliance_score < 80) color = 'oklch(0.58 0.20 28)'; // red
      else if (data.compliance_score < 95) color = 'oklch(0.74 0.13 75)'; // yellow
      
      if (compChart) compChart.destroy();
      const ctx = $('complianceChart').getContext('2d');
      compChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Sesuai Standar', 'Deviasi'],
          datasets: [{
            data: [data.compliance_score, 100 - data.compliance_score],
            backgroundColor: [color, 'rgba(0,0,0,0.05)'],
            borderWidth: 0,
            cutout: '75%'
          }]
        },
        options: { responsive: true, plugins: { legend: { display: false } } }
      });
      
      let totalDevMins = 0;
      let tbody = $('compliance-table-body');
      tbody.innerHTML = '';
      
      data.deviations.forEach(d => {
        totalDevMins += d.duration_minutes;
        tbody.innerHTML += `
          <tr style="border-bottom: 1px solid var(--hair);">
            <td style="padding: 8px;">${d.start}</td>
            <td style="padding: 8px;">${d.duration_minutes} m</td>
            <td style="padding: 8px;">${d.type}</td>
            <td style="padding: 8px;">${d.max_value}</td>
            <td style="padding: 8px;">${d.threshold}</td>
          </tr>
        `;
      });
      
      $('comp-total-dev').textContent = totalDevMins + ' menit';
      $('comp-incidents').textContent = data.deviations.length;
      
    } catch (e) {
      console.error(e);
      alert("Gagal load compliance");
    }
  });
}
"""

js = js + "\n" + new_logic

# 4. Modify init() to use initAuth and keepAlive
old_init = """function init() {
  initCharts();
  initSpeech();
  attachListeners();
  startClock();
  startPolling();
  navigateTo('dashboard');  // render halaman pertama setelah semua siap
  console.info('[ClimateOS v2.1] OK — backend:', CONFIG.API_BASE_URL);
}"""

new_init = """function init() {
  initCharts();
  initSpeech();
  attachListeners();
  startClock();
  startPolling();
  keepAlive();
  
  // Custom navigation handled by Auth
  initAuth();
  
  // Set default date for compliance to today
  if ($('compliance-date')) {
    const today = new Date().toISOString().split('T')[0];
    $('compliance-date').value = today;
  }
  
  setInterval(fetchSensorStatus, 60000); // Check sensor status every minute
  
  console.info('[MediClimate RS] OK — backend:', CONFIG.API_BASE_URL);
}"""

js = js.replace(old_init, new_init)

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(js)

print("public/app.js patched!")
