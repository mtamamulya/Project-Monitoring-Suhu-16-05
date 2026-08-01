/**
 * ============================================================
 *  ClimateOS — ESP32 Firmware (v2 — RSND, 6 Ruangan)
 *  Hardware : ESP32 DevKit + DHT22 Sensor + LCD I2C 20x4
 *  Daya     : Baterai Li-ion 18650 + modul charging (mis. TP4056)
 *             — lihat catatan BATERAI & KALIBRASI di bawah.
 *
 *  Firmware INI SATU-SATUNYA yang dipakai untuk ke-6 unit RSND —
 *  cukup ganti DEVICE_ID (lihat daftar di bawah) sebelum flash tiap unit.
 *  Varian lama (NICU-1.ino, pakai Blynk + Google Sheets) TIDAK dipakai lagi.
 * ============================================================
 *
 *  Wiring DHT22:
 *  ┌─────────┬───────────────┐
 *  │ DHT22   │ ESP32         │
 *  ├─────────┼───────────────┤
 *  │ VCC (+) │ 3.3V          │
 *  │ DATA    │ GPIO 4        │
 *  │ GND (-) │ GND           │
 *  └─────────┴───────────────┘
 *  Pasang resistor pull-up 10kΩ antara VCC dan DATA pin.
 *  Sensor sebaiknya dipasang DI DALAM housing/enclosure alat (bukan menjuntai
 *  bebas) supaya tidak kesenggol / bergeser — ini murni pertimbangan fisik,
 *  tidak ada penyesuaian kode yang diperlukan untuk itu.
 *
 *  ── DAFTAR DEVICE_ID (6 RUANGAN RSND) — pilih SATU sebelum flash ──────────
 *    BERSALIN-01      Ruang Bersalin 1
 *    BERSALIN-02      Ruang Bersalin 2
 *    OBAT-01          Ruang Obat
 *    PERINATOLOGI-01  Ruang Perinatologi
 *    RAWATINAP-01     Ruang Rawat Inap 1
 *    NURSESTATION-01  Nurse Station
 *  ID ini HARUS sama persis dengan yang terdaftar di backend
 *  (services/config.py) — kalau beda, data tidak akan dikenali sistem.
 *
 *  ── KALIBRASI SENSOR ─────────────────────────────────────────────────────
 *  Offset kalibrasi (kalau ada selisih antar unit DHT22) SENGAJA TIDAK
 *  di-hardcode di firmware ini — offset disimpan & diterapkan di backend per
 *  device_id, supaya bisa dikoreksi kapan saja tanpa reflash ulang tiap unit.
 *  (Lihat dokumen spesifikasi bagian 4.4 — pastikan backend sudah menerapkan
 *  offset ini sebelum kalibrasi dipakai di lapangan.)
 *
 *  ── BATERAI 18650 ────────────────────────────────────────────────────────
 *  Supaya baterai tahan lama, firmware ini TIDAK menyalakan WiFi terus-
 *  menerus (beda dari versi lama yang polling 15 detik non-stop). Radio WiFi
 *  adalah konsumen daya terbesar di ESP32 (~150-250mA saat aktif vs mikro-
 *  amp saat off), jadi WiFi hanya dinyalakan sebentar tiap SEND_INTERVAL_MS
 *  untuk kirim data, lalu dimatikan lagi. LCD tetap menyala terus dan update
 *  tiap LCD_REFRESH_MS dari pembacaan sensor lokal (tidak butuh WiFi), jadi
 *  staf tetap bisa lihat angka terkini kapan saja tanpa delay.
 *  Kalau nanti perlu baterai lebih awet lagi, opsi lanjutannya adalah true
 *  deep-sleep (esp_deep_sleep) — tapi itu akan membuat LCD ikut mati saat
 *  sleep, jadi belum dipakai di sini supaya LCD tetap informatif buat staf.
 *
 *  ── JARINGAN WIFI ────────────────────────────────────────────────────────
 *  Pakai WiFiMulti — daftarkan semua SSID yang tersedia di WIFI_CREDENTIALS
 *  di bawah, firmware otomatis pilih & connect ke salah satu yang tersedia
 *  tanpa perlu dikonfigurasi ulang manual kalau salah satu jaringan mati.
 *  CATATAN: kalau jaringan RSND pakai captive portal (harus login lewat
 *  halaman browser) atau WPA2-Enterprise, WiFiMulti SAJA TIDAK CUKUP — ini
 *  masih menunggu konfirmasi dari tim IT RSND soal jenis jaringannya
 *  (lihat diskusi terpisah). Kalau ternyata captive portal, solusi yang
 *  disarankan adalah minta admin jaringan whitelist MAC address device ini,
 *  atau sediakan SSID terpisah khusus IoT tanpa portal.
 *
 *  Library yang dibutuhkan (install via Arduino Library Manager):
 *  - DHT sensor library by Adafruit
 *  - Adafruit Unified Sensor by Adafruit
 *  - ArduinoJson by Benoit Blanchon
 *  - LiquidCrystal I2C by Frank de Brabander (untuk LCD I2C)
 *  - WiFi / WiFiMulti / WiFiClientSecure / HTTPClient — bawaan ESP32 core,
 *    tidak perlu install terpisah.
 * ============================================================
 */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ── Konfigurasi LCD I2C 20x4 ──────────────────
#define LCD_ADDR  0x27
#define LCD_COLS  20
#define LCD_ROWS  4
#define LCD_SDA   21   // D16
#define LCD_SCL   22   // D17
LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);

// ── Custom Character (Ikon Termometer & Tetes) ─
byte iconThermo[8] = {
  0b00100,
  0b01010,
  0b01010,
  0b01110,
  0b01110,
  0b11111,
  0b11111,
  0b01110
};

byte iconDrop[8] = {
  0b00100,
  0b00100,
  0b01010,
  0b01010,
  0b10001,
  0b10001,
  0b10001,
  0b01110
};

byte iconDegree[8] = {
  0b01100,
  0b10010,
  0b10010,
  0b01100,
  0b00000,
  0b00000,
  0b00000,
  0b00000
};


// ── RAHASIA: WIFI & KUNCI PERANGKAT ──────────────────────────────────────────
// Password WiFi dan DEVICE_API_KEY TIDAK ditaruh di file ini, melainkan di
// secrets.h yang sudah masuk .gitignore. Tujuannya supaya keduanya tidak pernah
// bisa ikut ter-push ke GitHub karena lupa dihapus sebelum commit — kalau bocor,
// orang luar bisa mengirim data suhu palsu dan membungkam alarm dari jauh.
//
// Belum punya secrets.h? Salin dari contohnya:
//     Windows  : copy secrets.h.example secrets.h
//     Mac/Linux: cp secrets.h.example secrets.h
// lalu isi nilai aslinya.
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "File secrets.h tidak ditemukan. Salin secrets.h.example menjadi secrets.h di folder yang sama, lalu isi WiFi dan DEVICE_API_KEY."
#endif

// ── KONFIGURASI — UBAH BAGIAN INI SEBELUM FLASH ──────────────────
// Daftar jaringan WiFi diambil dari secrets.h (WIFI_NETWORKS_LIST). Firmware
// otomatis connect ke salah satu yang tersedia/terkuat (WiFiMulti), jadi unit
// bisa dipindah antar ruangan tanpa flash ulang.
struct WifiCred { const char* ssid; const char* password; };
WifiCred WIFI_CREDENTIALS[] = {
  WIFI_NETWORKS_LIST
};
WiFiMulti wifiMulti;

// URL endpoint backend Render kamu
#define API_ENDPOINT     "https://climateos-backend.onrender.com/api/telemetry"

// Catatan soal DEVICE_API_KEY (nilainya ada di secrets.h):
// Backend memverifikasi header X-Device-Key sebelum menerima data. Selama
// variabel DEVICE_API_KEY di Render belum diisi ATAU AUTH_ENFORCE belum true,
// backend masih menerima kiriman tanpa kunci — supaya 6 unit yang sudah
// terpasang tidak langsung mati sebelum sempat di-reflash. Setelah semua unit
// diperbarui, set AUTH_ENFORCE=true di Render untuk mengunci sepenuhnya.

// ── ID RUANGAN — SATU-SATUNYA BARIS YANG BERBEDA ANTAR UNIT ──────────────────
// WAJIB salah satu dari daftar di komentar atas file. Ubah baris ini saja
// sebelum flash tiap unit; DEVICE_API_KEY dan WiFi sama untuk semuanya.
#define DEVICE_ID        "PERINATOLOGI-01"

// Pin dan tipe sensor
#define DHT_PIN          4
#define DHT_TYPE         DHT22   // Ganti ke DHT11 jika pakai DHT11

// Interval kirim data ke server (dalam milidetik).
// 60 detik — jauh lebih jarang dari versi lama (15 detik) supaya baterai 18650
// tahan lama. Backend sendiri men-decimate penulisan permanen ke ~90 detik,
// jadi 60 detik di sini sudah cukup responsif tanpa boros radio WiFi.
#define SEND_INTERVAL_MS   60000

// Interval refresh LCD dari pembacaan sensor LOKAL (tidak butuh WiFi/kirim).
// Dibuat lebih sering dari SEND_INTERVAL_MS supaya staf selalu lihat angka
// terkini di layar, walau belum waktunya kirim ke server.
#define LCD_REFRESH_MS     5000

// Batas percobaan koneksi WiFi tiap siklus kirim (bukan retry tanpa henti).
#define WIFI_CONNECT_TIMEOUT_MS  15000

// ── Monitoring baterai (opsional) ────────────────────────────────
// Aktifkan HANYA setelah voltage divider terpasang di BATTERY_ADC_PIN.
// Pembagi tegangan umum: R1=100k (ke Bat+), R2=100k (ke GND), tengah ke ADC
// -> Vadc = Vbatt / 2. Sesuaikan BATTERY_DIVIDER_RATIO dengan resistor yang
// benar-benar dipasang (ukur multimeter, jangan asumsi resistor presisi).
#define BATTERY_MONITORING_ENABLED false
#define BATTERY_ADC_PIN            34
#define BATTERY_DIVIDER_RATIO       2.0f   // Vbatt = Vadc_terbaca * rasio ini
#define BATTERY_MAX_V               4.2f   // 18650 penuh
#define BATTERY_MIN_V               3.0f   // batas aman minimum (jangan lebih rendah)
// ─────────────────────────────────────────────────────────────────

// ── Inisialisasi Sensor ───────────────────────────────────────
DHT dht(DHT_PIN, DHT_TYPE);

// ── Status LED bawaan ESP32 (GPIO 2) ─────────────────────────
#define LED_PIN 2

// ── PENYARINGAN PEMBACAAN SENSOR ─────────────────────────────────────────────
// DHT22 punya dua kelemahan yang harus ditangani, dan keduanya BUKAN sekadar
// pembacaan gagal (NaN):
//
//   1. Saat baru menyala, sensor butuh waktu sebelum stabil. Pembacaan pertama
//      sering berupa nilai sampah yang secara teknis ANGKA SAH — misalnya 1,2 °C.
//      Pemeriksaan isnan() tidak menangkap ini sama sekali.
//   2. Sesekali saat berjalan, kegagalan checksum menghasilkan lonjakan liar.
//
// Nilai sampah yang lolos ke database jauh lebih berbahaya daripada data hilang,
// karena ikut tercetak di laporan akreditasi dan memicu alarm palsu.

// Lama pemanasan setelah alat menyala. Selama ini sensor tetap dibaca dan
// ditampilkan di LCD, tapi TIDAK dikirim ke server.
#define WARMUP_MS                 30000
// Berapa pembacaan sah berturut-turut yang harus terkumpul sebelum mulai kirim.
#define WARMUP_MIN_GOOD_READS     3

// Median dari beberapa sampel — lapis paling ampuh dan paling murah.
// Satu lonjakan liar otomatis terbuang karena tidak pernah menjadi nilai tengah.
#define SAMPLE_COUNT              5
#define SAMPLE_GAP_MS             2500   // DHT22 butuh >2 detik antar pembacaan

// Batas kewajaran fisik ruangan rumah sakit. Jauh lebih ketat dari batas
// datasheet DHT22 (-40..80 °C) yang tidak berguna untuk menyaring nilai sampah.
#define PHYS_TEMP_MIN             5.0f
#define PHYS_TEMP_MAX             50.0f
#define PHYS_HUM_MIN              10.0f
#define PHYS_HUM_MAX              99.0f

// Batas lompatan antar siklus. Suhu ruangan tidak mungkin berubah sebesar ini
// dalam satu menit — kalau terjadi, hampir pasti kesalahan baca.
#define MAX_JUMP_TEMP             5.0f
#define MAX_JUMP_HUM              15.0f

// Berapa siklus lonjakan yang sama harus bertahan sebelum diterima sebagai
// perubahan ASLI, bukan salah baca.
//
// Tanpa ini, guard lonjakan berbalik jadi bahaya: kalau AC benar-benar mati dan
// suhu melonjak 23 -> 35 °C lalu menetap, setiap pembacaan 35 akan terus ditolak
// karena acuannya tetap 23. Ruangan panas, tapi dashboard membeku di angka lama
// dan alarm tidak pernah berbunyi — jauh lebih berbahaya daripada nilai sampah
// yang mau dicegah.
//
// Dengan nilai 2, perubahan mendadak yang nyata tertunda paling lama 2 siklus
// (sekitar 2 menit), lalu diterima dan menjadi acuan baru.
#define JUMP_CONFIRM_COUNT        2

// Sensor dianggap bermasalah setelah sekian kali gagal berturut-turut.
#define SENSOR_FAIL_ALERT_COUNT   10

// ── Variabel global ───────────────────────────────────────────
unsigned long lastSendTime = 0;
unsigned long lastLcdRefresh = 0;
int failCount = 0;
bool wifiConnectedNow = false;

unsigned long bootTime = 0;          // waktu alat menyala, untuk hitung masa pemanasan
int goodReadStreak = 0;              // pembacaan sah berturut-turut sejak menyala
bool warmupDone = false;
float lastValidTemp = NAN;           // pembacaan sah terakhir, acuan guard lonjakan
float lastValidHum  = NAN;
int sensorRejectStreak = 0;          // penolakan berturut-turut — penanda sensor rusak
unsigned long totalRejected = 0;     // total penolakan sejak menyala (untuk diagnosa)

// Lonjakan yang sedang "diamati". Kalau nilai yang sama muncul lagi di siklus
// berikutnya, berarti perubahannya nyata dan harus diterima — lihat catatan
// pada JUMP_CONFIRM_COUNT.
float pendingTemp = NAN, pendingHum = NAN;
int   pendingCount = 0;

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Baterai (opsional)
// ─────────────────────────────────────────────────────────────
int readBatteryPercent() {
  if (!BATTERY_MONITORING_ENABLED) return -1;
  int raw = analogRead(BATTERY_ADC_PIN);          // 0-4095 (ADC 12-bit ESP32)
  float vAdc = (raw / 4095.0f) * 3.3f;
  float vBatt = vAdc * BATTERY_DIVIDER_RATIO;
  float pct = (vBatt - BATTERY_MIN_V) / (BATTERY_MAX_V - BATTERY_MIN_V) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (int)pct;
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Koneksi WiFi (WiFiMulti — otomatis pilih AP yang tersedia)
//  Dipanggil hanya sesaat sebelum kirim data, bukan terus-menerus, supaya
//  radio WiFi tidak menguras baterai saat idle.
// ─────────────────────────────────────────────────────────────
bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) { wifiConnectedNow = true; return true; }

  WiFi.mode(WIFI_STA);
  unsigned long start = millis();
  Serial.println("[WiFi] Mencoba connect ke jaringan terdaftar...");

  while (wifiMulti.run() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println("[WiFi] ✗ Gagal connect dalam batas waktu. Lanjut tanpa kirim siklus ini.");
      wifiConnectedNow = false;
      WiFi.mode(WIFI_OFF);   // matikan radio lagi supaya tidak boros baterai
      return false;
    }
    delay(300);
  }

  Serial.println("[WiFi] ✓ Terhubung ke: " + WiFi.SSID());
  Serial.println("[WiFi] IP Address: " + WiFi.localIP().toString());
  wifiConnectedNow = true;
  return true;
}

/** Matikan radio WiFi setelah selesai kirim — ini yang paling hemat baterai. */
void disconnectWiFi() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  wifiConnectedNow = false;
}

// ─────────────────────────────────────────────────────────────
//  PENYARINGAN SENSOR — lihat catatan panjang di bagian konstanta
// ─────────────────────────────────────────────────────────────

/** Nilai tengah dari sebuah larik kecil. Menyalin dulu supaya larik asli utuh. */
float median(float *src, int n) {
  float a[SAMPLE_COUNT];
  for (int i = 0; i < n; i++) a[i] = src[i];
  // Insertion sort — n cuma 5, tidak perlu algoritma rumit.
  for (int i = 1; i < n; i++) {
    float k = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > k) { a[j + 1] = a[j]; j--; }
    a[j + 1] = k;
  }
  return (n % 2) ? a[n / 2] : (a[n / 2 - 1] + a[n / 2]) / 2.0f;
}

/** LAPIS 1: satu pembacaan mentah, ditolak kalau NaN atau di luar batas fisik. */
bool readOnce(float &t, float &h) {
  h = dht.readHumidity();
  t = dht.readTemperature();   // Celsius — kalibrasi diterapkan di backend, BUKAN di sini

  if (isnan(h) || isnan(t)) return false;

  // Inilah saringan yang menangkap nilai sampah saat sensor baru menyala —
  // pembacaan seperti 1,2 °C lolos dari isnan() tapi tertahan di sini.
  if (t < PHYS_TEMP_MIN || t > PHYS_TEMP_MAX) return false;
  if (h < PHYS_HUM_MIN  || h > PHYS_HUM_MAX)  return false;
  return true;
}

/**
 * Baca sensor dengan penyaringan lengkap.
 *
 *   quick = true  -> satu pembacaan saja, untuk menyegarkan LCD (cepat, tanpa jeda)
 *   quick = false -> ambil SAMPLE_COUNT sampel lalu nilai tengahnya, untuk dikirim
 *
 * Mengembalikan false kalau pembacaan tidak layak dipakai.
 */
bool readSensor(float &temperature, float &humidity, bool quick = false) {
  if (quick) {
    return readOnce(temperature, humidity);
  }

  // LAPIS 2 — median beberapa sampel.
  float ts[SAMPLE_COUNT], hs[SAMPLE_COUNT];
  int n = 0;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    float t, h;
    if (readOnce(t, h)) { ts[n] = t; hs[n] = h; n++; }
    if (i < SAMPLE_COUNT - 1) delay(SAMPLE_GAP_MS);
  }

  // Butuh mayoritas sampel sah. Kalau kurang dari separuh, sensornya bermasalah —
  // bukan sekadar satu pembacaan meleset.
  if (n < (SAMPLE_COUNT / 2 + 1)) {
    sensorRejectStreak++;
    totalRejected++;
    Serial.println("[Sensor] ✗ Hanya " + String(n) + "/" + String(SAMPLE_COUNT) +
                   " sampel sah — pembacaan dibuang.");
    return false;
  }

  float t = median(ts, n);
  float h = median(hs, n);

  // LAPIS 3 — guard lompatan. Dilewati saat pembacaan sah pertama (belum ada acuan).
  if (!isnan(lastValidTemp)) {
    bool lompatSuhu = fabs(t - lastValidTemp) > MAX_JUMP_TEMP;
    bool lompatHum  = fabs(h - lastValidHum)  > MAX_JUMP_HUM;

    if (lompatSuhu || lompatHum) {
      // Apakah lonjakan ini sama dengan yang diamati siklus sebelumnya?
      // Kalau ya, berarti nilainya bertahan — perubahan nyata, bukan salah baca.
      bool samaSepertiSebelumnya = !isnan(pendingTemp) &&
                                   fabs(t - pendingTemp) <= MAX_JUMP_TEMP &&
                                   fabs(h - pendingHum)  <= MAX_JUMP_HUM;

      if (samaSepertiSebelumnya) {
        pendingCount++;
      } else {
        pendingTemp = t; pendingHum = h; pendingCount = 1;
      }

      if (pendingCount < JUMP_CONFIRM_COUNT) {
        sensorRejectStreak++;
        totalRejected++;
        Serial.println("[Sensor] ? Lonjakan " + String(fabs(t - lastValidTemp), 1) +
                       " °C dari " + String(lastValidTemp, 1) +
                       " — ditahan dulu, menunggu konfirmasi siklus berikutnya.");
        return false;
      }

      // Bertahan cukup lama: terima sebagai keadaan baru. Ini yang mencegah
      // sistem buntu saat AC benar-benar mati dan suhu melonjak lalu menetap.
      Serial.println("[Sensor] ! Lonjakan bertahan " + String(pendingCount) +
                     " siklus — diterima sebagai perubahan NYATA: " +
                     String(lastValidTemp, 1) + " -> " + String(t, 1) + " °C.");
    }
  }

  temperature = t;
  humidity    = h;
  lastValidTemp = t;
  lastValidHum  = h;
  pendingTemp = NAN; pendingHum = NAN; pendingCount = 0;
  sensorRejectStreak = 0;
  return true;
}

/**
 * LAPIS 0 — masa pemanasan.
 * DHT22 butuh waktu sebelum stabil setelah alat menyala. Selama masa ini sensor
 * tetap dibaca dan ditampilkan di LCD, tapi TIDAK dikirim ke server, supaya nilai
 * sampah awal tidak pernah masuk database.
 *
 * Pemanasan dinyatakan selesai kalau DUA syarat terpenuhi: waktunya sudah lewat,
 * DAN sudah terkumpul beberapa pembacaan sah berturut-turut. Syarat kedua penting —
 * kalau sensornya memang rusak, waktu saja tidak membuktikan apa-apa.
 */
bool warmupSelesai() {
  if (warmupDone) return true;

  if (millis() - bootTime < WARMUP_MS) return false;
  if (goodReadStreak < WARMUP_MIN_GOOD_READS) return false;

  warmupDone = true;
  Serial.println("[Sensor] ✓ Masa pemanasan selesai — pengiriman data dimulai.");
  return true;
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Kirim Data ke Backend API
//  Return false kalau WiFi gagal connect ATAU HTTP request gagal.
// ─────────────────────────────────────────────────────────────
bool sendTelemetry(float temperature, float humidity) {
  if (!connectWiFi()) return false;

  StaticJsonDocument<128> doc;
  doc["temperature"] = round(temperature * 100.0) / 100.0;  // 2 desimal
  doc["humidity"]    = round(humidity * 100.0) / 100.0;
  doc["device_id"]   = DEVICE_ID;

  String payload;
  serializeJson(doc, payload);
  Serial.println("[HTTP] Mengirim: " + payload);

  WiFiClientSecure client;
  client.setInsecure();  // Skip SSL cert verification
                         // Untuk produksi pakai: client.setCACert(root_ca);

  HTTPClient http;
  http.begin(client, API_ENDPOINT);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);  // wajib — lihat catatan di atas
  http.setTimeout(10000);  // 10 detik timeout

  int httpCode = http.POST(payload);
  String response = http.getString();
  http.end();
  disconnectWiFi();   // radio dimatikan lagi segera setelah kirim, sukses ataupun gagal

  if (httpCode == 201) {
    Serial.println("[HTTP] ✓ Berhasil! Code: " + String(httpCode));
    failCount = 0;
    return true;
  } else {
    Serial.println("[HTTP] ✗ Gagal! Code: " + String(httpCode) + " Response: " + response);

    // 401 = kunci perangkat salah/tidak dikirim. Restart tidak akan menolong,
    // justru menghabiskan baterai percuma. Beri tahu jelas dan tetap kirim
    // berkala supaya begitu kunci di server dibetulkan, unit pulih sendiri.
    if (httpCode == 401) {
      Serial.println("[HTTP] !! DEVICE_API_KEY di firmware TIDAK COCOK dengan");
      Serial.println("[HTTP]    DEVICE_API_KEY di Render. Perbaiki lalu flash ulang.");
      failCount = 0;   // jangan hitung sebagai kegagalan jaringan
      return false;
    }

    failCount++;
    if (failCount >= 5) {
      Serial.println("[System] Terlalu banyak kegagalan berturut-turut. Restart...");
      delay(2000);
      ESP.restart();
    }
    return false;
  }
}

// ─── Fungsi Tampilkan Header LCD ────────────────
void tampilkanHeader() {
  lcd.clear();
  lcd.setCursor(3, 0);
  lcd.print("=== MONITOR ===");
  lcd.setCursor(2, 1);
  lcd.print("Suhu & Kelembaban");
  delay(2000);
  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.write(byte(0));
  lcd.print(" Suhu      : ");

  lcd.setCursor(0, 1);
  lcd.write(byte(1));
  lcd.print(" Kelembaban: ");

  lcd.setCursor(0, 2);
  lcd.print("  Heat Index: ");

  lcd.setCursor(0, 3);
  lcd.print("--------------------");
}

// ─── Fungsi Update Nilai di LCD ─────────────────
void updateNilaiLCD(float suhu, float kelembaban, float heatIndex) {
  lcd.setCursor(13, 0);
  if (isnan(suhu)) { lcd.print("ERROR  "); }
  else { lcd.print(suhu, 1); lcd.write(byte(2)); lcd.print("C "); }

  lcd.setCursor(13, 1);
  if (isnan(kelembaban)) { lcd.print("ERROR  "); }
  else { lcd.print(kelembaban, 1); lcd.print("%   "); }

  lcd.setCursor(13, 2);
  if (isnan(heatIndex)) { lcd.print("ERROR "); }
  else { lcd.print(heatIndex, 1); lcd.write(byte(2)); lcd.print("C "); }

  // Baris status. Urutan prioritas dipilih berdasarkan apa yang paling perlu
  // diketahui petugas saat melihat layar:
  //   1. Sensor bermasalah  — angka di layar tidak bisa dipercaya
  //   2. Sedang memanas     — angka sudah tampil tapi belum dikirim ke server
  //   3. Status WiFi/baterai — keadaan normal
  lcd.setCursor(2, 3);
  String statusLine;
  if (sensorRejectStreak >= SENSOR_FAIL_ALERT_COUNT) {
    statusLine = "SENSOR BERMASALAH";
  } else if (!warmupDone) {
    unsigned long lewat = millis() - bootTime;
    int sisa = (lewat < WARMUP_MS) ? (WARMUP_MS - lewat) / 1000 : 0;
    statusLine = "Pemanasan " + String(sisa) + "s";
  } else {
    statusLine = wifiConnectedNow ? "WiFi: OK" : "WiFi: Off (hemat)";
    if (BATTERY_MONITORING_ENABLED) {
      int pct = readBatteryPercent();
      statusLine += "  Bat:" + String(pct) + "%";
    }
  }
  while (statusLine.length() < 18) statusLine += ' ';  // padding biar sisa karakter lama ketimpa
  lcd.print(statusLine.substring(0, 18));
}

// ─────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  if (BATTERY_MONITORING_ENABLED) pinMode(BATTERY_ADC_PIN, INPUT);

  Serial.println("╔══════════════════════════════╗");
  Serial.println("║   ClimateOS ESP32 Firmware   ║");
  Serial.println("║   Device: " + String(DEVICE_ID) + "  ║");
  Serial.println("╚══════════════════════════════╝");

  dht.begin();
  Serial.println("[Sensor] DHT22 diinisialisasi pada GPIO " + String(DHT_PIN));

  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init();
  lcd.backlight();
  lcd.createChar(0, iconThermo);
  lcd.createChar(1, iconDrop);
  lcd.createChar(2, iconDegree);

  lcd.setCursor(0, 0);
  lcd.print(F("ClimateOS ESP32"));
  lcd.setCursor(0, 2);
  lcd.print(F("Starting..."));
  Serial.println(F("[LCD] Diinisialisasi"));

  // Daftarkan semua kredensial WiFi yang tersedia ke WiFiMulti
  for (auto &cred : WIFI_CREDENTIALS) {
    wifiMulti.addAP(cred.ssid, cred.password);
  }

  Serial.println("[System] Menunggu sensor stabil (3 detik)...");
  delay(3000);

  bootTime = millis();   // titik awal masa pemanasan

  Serial.println("[System] Siap. Kirim tiap " + String(SEND_INTERVAL_MS / 1000) +
                  " detik, refresh LCD tiap " + String(LCD_REFRESH_MS / 1000) + " detik.");
  Serial.println("[System] WiFi HANYA aktif sesaat saat kirim data (hemat baterai 18650).");
  Serial.println("[System] Masa pemanasan " + String(WARMUP_MS / 1000) + " detik — selama itu "
                 "sensor dibaca & tampil di LCD, tapi BELUM dikirim ke server.");

  tampilkanHeader();

  // WiFi dimatikan dari awal — baru dinyalakan sesaat sebelum siklus kirim pertama
  WiFi.mode(WIFI_OFF);
}

// ─────────────────────────────────────────────────────────────
//  LOOP UTAMA
//  Pola: baca+tampilkan sensor SERING (LCD_REFRESH_MS, tanpa WiFi), tapi
//  kirim ke server JARANG (SEND_INTERVAL_MS, WiFi nyala sebentar lalu mati).
// ─────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── Refresh LCD dari pembacaan sensor lokal ──
  // Pakai mode 'quick' (satu pembacaan) supaya LCD tetap responsif — mengambil
  // 5 sampel di sini akan membuat tampilan tersendat 10 detik tiap siklus.
  if (now - lastLcdRefresh >= LCD_REFRESH_MS || lastLcdRefresh == 0) {
    lastLcdRefresh = now;
    float temperature, humidity;

    if (readSensor(temperature, humidity, true)) {
      if (goodReadStreak < 1000) goodReadStreak++;   // dipakai menutup masa pemanasan
      float heatIndex = dht.computeHeatIndex(temperature, humidity, false);
      updateNilaiLCD(temperature, humidity, heatIndex);
      Serial.println("[Sensor] Suhu: " + String(temperature, 1) + "C  Kelembaban: " + String(humidity, 1) + "%" +
                     (warmupDone ? "" : "   (pemanasan)"));
    } else {
      goodReadStreak = 0;   // rentetan terputus, masa pemanasan diulang dari nol
      updateNilaiLCD(NAN, NAN, NAN);
      for (int i = 0; i < 4; i++) { digitalWrite(LED_PIN, !digitalRead(LED_PIN)); delay(300); }
    }
  }

  // ── Kirim ke server (radio WiFi cuma nyala di sini) ──
  if (now - lastSendTime >= SEND_INTERVAL_MS || lastSendTime == 0) {
    lastSendTime = now;

    // LAPIS 0 — jangan kirim apa pun selama masa pemanasan. Nilai sampah awal
    // DHT22 (misalnya 1,2 °C) tertahan di sini dan tidak pernah masuk database.
    if (!warmupSelesai()) {
      unsigned long sisa = (millis() - bootTime < WARMUP_MS)
                           ? (WARMUP_MS - (millis() - bootTime)) / 1000 : 0;
      Serial.println("[Sensor] Masa pemanasan — belum mengirim. Sisa ~" + String(sisa) +
                     " detik, pembacaan sah berturut-turut: " + String(goodReadStreak) +
                     "/" + String(WARMUP_MIN_GOOD_READS));
    } else {
      float temperature, humidity;

      if (readSensor(temperature, humidity)) {
        digitalWrite(LED_PIN, LOW);
        bool success = sendTelemetry(temperature, humidity);
        if (success) {
          digitalWrite(LED_PIN, HIGH);
          delay(200);
          digitalWrite(LED_PIN, LOW);
        } else {
          for (int i = 0; i < 6; i++) { digitalWrite(LED_PIN, !digitalRead(LED_PIN)); delay(150); }
        }
        // Refresh LCD sekali lagi supaya status WiFi/baterai yang baru langsung kelihatan
        float heatIndex = dht.computeHeatIndex(temperature, humidity, false);
        updateNilaiLCD(temperature, humidity, heatIndex);
      } else {
        // Penolakan dicatat, tidak dibuang diam-diam. Sensor yang sering ditolak
        // berarti mulai rusak — itu informasi berharga bagi teknisi.
        Serial.println("[Sensor] Siklus kirim dilewati. Penolakan berturut-turut: " +
                       String(sensorRejectStreak) + ", total sejak menyala: " + String(totalRejected));
        if (sensorRejectStreak >= SENSOR_FAIL_ALERT_COUNT) {
          Serial.println("[Sensor] !! SENSOR BERMASALAH — " + String(sensorRejectStreak) +
                         " penolakan berturut-turut. Periksa wiring atau ganti DHT22.");
        }
      }
    }
  }

  delay(100);  // yield supaya watchdog timer tidak trigger
}
