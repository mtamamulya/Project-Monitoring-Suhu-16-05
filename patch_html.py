import sys

with open('public/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Rebranding strings
html = html.replace('<title>ClimateOS — Semarang Room Monitor</title>', '<title>MediClimate RS</title>')
html = html.replace('ClimateOS', 'MediClimate RS')
html = html.replace('SEMARANG MONITOR', 'RSUD / Bangsal Anak & Neonatal')
html = html.replace('Semarang Room Monitor', 'Sistem Monitoring Iklim Bangsal — Rumah Sakit')

# 2. Add Firebase Auth SDK
fb_scripts = """  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js"></script>
"""
if "firebase-app-compat" not in html:
    html = html.replace('</head>', fb_scripts + '</head>')

# 3. Add Login Screen before app-shell
login_screen = """
  <!-- ════ LOGIN SCREEN ════ -->
  <div id="login-screen" style="position: fixed; inset: 0; z-index: 9999; background: var(--bg); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px;">
    <div style="max-width: 400px; width: 100%; text-align: center; margin-bottom: 30px;">
      <div class="logo-mark" style="width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 12px;">
        <svg style="width: 28px; height: 28px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      </div>
      <h1 class="num-lg text-ink">MediClimate RS</h1>
      <p class="text-muted" style="margin-top: 8px;">Sistem Monitoring Iklim Bangsal — Rumah Sakit</p>
    </div>

    <div class="card-elev" style="width: 100%; max-width: 400px; padding: 24px;">
      <form id="login-form" onsubmit="event.preventDefault();">
        <div style="margin-bottom: 16px;">
          <label class="label" style="display: block; margin-bottom: 6px;">Email Petugas</label>
          <input type="email" id="login-email" class="input" placeholder="admin@mediclimate.rs" required />
        </div>
        <div style="margin-bottom: 24px;">
          <label class="label" style="display: block; margin-bottom: 6px;">Password</label>
          <input type="password" id="login-pass" class="input" placeholder="••••••••" required />
        </div>
        <div id="login-error" style="color: var(--crit); font-size: 13px; font-weight: 500; margin-bottom: 16px; display: none;"></div>
        
        <button type="submit" class="btn-primary" style="width: 100%; justify-content: center; padding: 12px;">
          Login Akses Internal
        </button>
      </form>
      
      <div class="divider" style="margin: 24px 0;"></div>
      
      <button onclick="window.showApp('publik')" class="btn-ghost" style="width: 100%; justify-content: center; padding: 12px;">
        Lihat Data Publik (Terbatas)
      </button>
    </div>
  </div>
"""

if 'id="login-screen"' not in html:
    html = html.replace('<body>\n  <!-- ─────────────────────────────── APP SHELL ─────────────────────────────── -->', f'<body>\n{login_screen}\n  <!-- ─────────────────────────────── APP SHELL ─────────────────────────────── -->')

# 4. Add Public Mode Banner
public_banner = """
      <!-- Public Banner -->
      <div id="public-banner" style="display: none; background: var(--amber-soft); color: var(--amber); text-align: center; padding: 8px; font-size: 12px; font-weight: 600;">
        MODE PUBLIK — Akses Terbatas. Login untuk melihat informasi bangsal spesifik dan alert.
      </div>
"""
if 'id="public-banner"' not in html:
    html = html.replace('<!-- Top Header -->', f'{public_banner}\n      <!-- Top Header -->')

# 5. Add "Bangsal" page to Nav
bangsal_nav = """        <button class="nav-item" data-page="bangsal" id="nav-bangsal">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>
          </svg>
          Bangsal
        </button>"""

if 'data-page="bangsal"' not in html:
    html = html.replace('        <div class="nav-label" style="margin-top: 8px;">System</div>', f'{bangsal_nav}\n\n        <div class="nav-label" style="margin-top: 8px;">System</div>')

# 6. Add "Bangsal" page content
bangsal_page = """
        <!-- ════════ PAGE: BANGSAL ════════ -->
        <div id="page-bangsal" class="page">
          <div id="offline-warning-banner" style="display: none; background: var(--crit-soft); color: var(--crit); padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 500; align-items: center; gap: 8px; border: 1px solid oklch(0.85 0.10 28);">
            ⚠️ <span id="offline-warning-text">Beberapa sensor tidak terhubung!</span>
          </div>

          <div id="bangsal-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;">
            <!-- Rendered by JS -->
          </div>
        </div>
"""
if 'id="page-bangsal"' not in html:
    html = html.replace('        <!-- ════════ PAGE: HISTORY ════════ -->', f'{bangsal_page}\n        <!-- ════════ PAGE: HISTORY ════════ -->')

# 7. Add Compliance section to History page
compliance_html = """
          <!-- Compliance Section -->
          <div class="card-flat" style="padding: 20px; margin-top: 24px;" id="compliance-section">
            <div class="flex items-center justify-between mb-4">
              <h3 class="label-strong">Compliance Report Harian</h3>
            </div>
            
            <div style="display: flex; gap: 12px; margin-bottom: 16px;">
              <select id="compliance-room" class="input" style="width: 200px;">
                <option value="NICU-01">NICU</option>
                <option value="BANGSAL-A">Bangsal Bayi</option>
                <option value="BANGSAL-B">Bangsal Anak Umum</option>
                <option value="ISOLASI-01">Ruang Isolasi</option>
              </select>
              <input type="date" id="compliance-date" class="input" style="width: 150px;">
              <button id="btn-load-compliance" class="btn-ghost">Load Report</button>
            </div>

            <div id="compliance-result" style="display: none;">
              <div class="analysis-row">
                <div class="insight-card flex flex-col items-center justify-center">
                  <div style="position: relative; width: 120px; height: 120px;">
                    <canvas id="complianceChart"></canvas>
                    <div id="compliance-score-text" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 20px;">--%</div>
                  </div>
                  <div class="mt-3 text-sm font-semibold">Tingkat Kepatuhan (Suhu & Kelembapan)</div>
                </div>
                <div class="insight-card">
                  <h4 class="label-strong mb-2">Ringkasan Deviasi</h4>
                  <p class="text-sm mb-1">Total durasi: <span id="comp-total-dev" class="font-bold">0 menit</span></p>
                  <p class="text-sm mb-3">Jumlah insiden: <span id="comp-incidents" class="font-bold">0</span></p>
                  <button id="btn-export-pdf" class="btn-primary" style="width: 100%; justify-content: center;">
                    Unduh PDF Laporan Harian
                  </button>
                </div>
              </div>

              <div class="insight-card">
                <h4 class="label-strong mb-2">Daftar Deviasi Hari Ini</h4>
                <div style="overflow-x: auto;">
                  <table style="width: 100%; font-size: 13px; text-align: left; border-collapse: collapse;">
                    <thead>
                      <tr style="border-bottom: 1px solid var(--hair);">
                        <th style="padding: 8px;">Waktu Mulai</th>
                        <th style="padding: 8px;">Durasi</th>
                        <th style="padding: 8px;">Tipe</th>
                        <th style="padding: 8px;">Nilai Puncak</th>
                        <th style="padding: 8px;">Batas Toleransi</th>
                      </tr>
                    </thead>
                    <tbody id="compliance-table-body">
                      <!-- injected by js -->
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
"""
if 'id="compliance-section"' not in html:
    html = html.replace('          <!-- History Chart -->', f'{compliance_html}\n          <!-- History Chart -->')

# 8. Sensor Pill in Header
sensor_pill = """
          <div class="pill" id="header-sensor-pill">
            <span class="dot hb-dot" id="sensor-pill-dot"></span>
            <span id="sensor-pill-text">0/4 Sensor Online</span>
          </div>"""
if 'id="header-sensor-pill"' not in html:
    html = html.replace('          <div class="pill" style="display: none;" id="header-live-pill">', f'{sensor_pill}\n          <div class="pill" style="display: none;" id="header-live-pill">')

# 9. Sidebar user info
user_info = """
        <div id="sidebar-user" style="font-size: 12px; font-weight: 500; text-align: center; color: var(--muted-2); margin-top: 4px; display: none;">
          <span id="user-email-text"></span> | <a href="#" id="btn-logout" style="color: var(--coral);">Logout</a>
        </div>
"""
if 'id="sidebar-user"' not in html:
    html = html.replace('      <div class="sidebar-footer">', f'      <div class="sidebar-footer">\n{user_info}')

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("public/index.html patched!")
