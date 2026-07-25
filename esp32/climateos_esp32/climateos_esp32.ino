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


// ── KONFIGURASI — UBAH BAGIAN INI SEBELUM FLASH ──────────────────
// Daftar semua jaringan WiFi yang tersedia di lokasi pemasangan.
// Firmware otomatis connect ke salah satu yang sinyalnya tersedia/terkuat.
// Tambah/kurangi baris sesuai kebutuhan lapangan.
struct WifiCred { const char* ssid; const char* password; };
WifiCred WIFI_CREDENTIALS[] = {
  { "om bob meresahkan", "ayamgeprek" },
  // { "SSID_CADANGAN_RSND", "password_cadangan" },
};
WiFiMulti wifiMulti;

// URL endpoint backend Render kamu
#define API_ENDPOINT     "https://climateos-backend.onrender.com/api/telemetry"

// ── KUNCI PERANGKAT ───────────────────────────────────────────────────────────
// Backend memverifikasi header X-Device-Key sebelum menerima data. Tanpa ini,
// siapa pun yang tahu URL backend bisa mengirim data suhu palsu — alarm bisa
// dibungkam atau dipicu dari luar rumah sakit.
//
// Nilai di bawah HARUS SAMA PERSIS dengan variabel DEVICE_API_KEY di dashboard
// Render (Environment > Add Environment Variable). Gunakan string acak panjang,
// bukan kata yang mudah ditebak. Sama untuk semua 6 unit.
//
// Selama DEVICE_API_KEY di Render belum diisi (atau AUTH_ENFORCE belum true),
// backend masih menerima kiriman tanpa kunci — supaya perangkat lama tidak
// langsung mati sebelum sempat di-reflash. Setelah semua unit diperbarui,
// aktifkan AUTH_ENFORCE=true di Render untuk mengunci sepenuhnya.
#define DEVICE_API_KEY   "ganti-dengan-kunci-acak-panjang"

// ID unik ruangan ini — WAJIB salah satu dari daftar di komentar atas file.
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

// ── Variabel global ───────────────────────────────────────────
unsigned long lastSendTime = 0;
unsigned long lastLcdRefresh = 0;
int failCount = 0;
bool wifiConnectedNow = false;

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
//  FUNGSI: Baca Sensor DHT22
//  Mengembalikan false jika pembacaan gagal (NaN)
// ─────────────────────────────────────────────────────────────
bool readSensor(float &temperature, float &humidity) {
  humidity    = dht.readHumidity();
  temperature = dht.readTemperature();  // Celsius — kalibrasi diterapkan di backend, BUKAN di sini

  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("[Sensor] ✗ Gagal membaca DHT22. Cek wiring!");
    return false;
  }

  if (temperature < -40 || temperature > 80) {
    Serial.println("[Sensor] ✗ Nilai suhu di luar range: " + String(temperature));
    return false;
  }
  if (humidity < 0 || humidity > 100) {
    Serial.println("[Sensor] ✗ Nilai kelembaban di luar range: " + String(humidity));
    return false;
  }

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

  // Baris status: WiFi + baterai (kalau monitoring aktif)
  lcd.setCursor(2, 3);
  String statusLine = wifiConnectedNow ? "WiFi: OK" : "WiFi: Off (hemat)";
  if (BATTERY_MONITORING_ENABLED) {
    int pct = readBatteryPercent();
    statusLine += "  Bat:" + String(pct) + "%";
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

  Serial.println("[System] Siap. Kirim tiap " + String(SEND_INTERVAL_MS / 1000) +
                  " detik, refresh LCD tiap " + String(LCD_REFRESH_MS / 1000) + " detik.");
  Serial.println("[System] WiFi HANYA aktif sesaat saat kirim data (hemat baterai 18650).");

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
  if (now - lastLcdRefresh >= LCD_REFRESH_MS || lastLcdRefresh == 0) {
    lastLcdRefresh = now;
    float temperature, humidity;

    if (readSensor(temperature, humidity)) {
      float heatIndex = dht.computeHeatIndex(temperature, humidity, false);
      updateNilaiLCD(temperature, humidity, heatIndex);
      Serial.println("[Sensor] Suhu: " + String(temperature, 1) + "C  Kelembaban: " + String(humidity, 1) + "%");
    } else {
      updateNilaiLCD(NAN, NAN, NAN);
      for (int i = 0; i < 4; i++) { digitalWrite(LED_PIN, !digitalRead(LED_PIN)); delay(300); }
    }
  }

  // ── Kirim ke server (radio WiFi cuma nyala di sini) ──
  if (now - lastSendTime >= SEND_INTERVAL_MS || lastSendTime == 0) {
    lastSendTime = now;
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
    }
  }

  delay(100);  // yield supaya watchdog timer tidak trigger
}
