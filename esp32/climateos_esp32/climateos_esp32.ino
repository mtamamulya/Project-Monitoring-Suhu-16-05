/**
 * ============================================================
 *  ClimateOS — ESP32 Firmware
 *  Hardware : ESP32 DevKit + DHT22 Sensor
 *  Tujuan   : Baca suhu & kelembaban, kirim ke Firebase
 *             endpoint /api/telemetry setiap interval tertentu.
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
 *
 *  Library yang dibutuhkan (install via Arduino Library Manager):
 *  - DHT sensor library by Adafruit
 *  - Adafruit Unified Sensor by Adafruit
 *  - ArduinoJson by Benoit Blanchon
 *  - WiFiClientSecure (built-in ESP32 core)
 *  - HTTPClient (built-in ESP32 core)
 *  - LiquidCrystal I2C by Frank de Brabander (untuk LCD I2C)
 * ============================================================
 */

#include <WiFi.h>
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


// ── KONFIGURASI — UBAH BAGIAN INI ────────────────────────────
#define WIFI_SSID        "om bob meresahkan"
#define WIFI_PASSWORD    "ayamgeprek"

// URL endpoint backend Render kamu
#define API_ENDPOINT     "https://climateos-backend.onrender.com/api/telemetry"

// ID unik untuk perangkat ini (bebas diisi apa saja)
#define DEVICE_ID        "NICU-01"

// Pin dan tipe sensor
#define DHT_PIN          4
#define DHT_TYPE         DHT11   // Ganti ke DHT11 jika pakai DHT11

// Interval pengiriman data (dalam milidetik)
// Default: 15 detik — sesuai polling interval dashboard
#define SEND_INTERVAL_MS 15000

// Batas retry koneksi WiFi
#define WIFI_MAX_RETRY   20
// ─────────────────────────────────────────────────────────────

// ── Inisialisasi Sensor ───────────────────────────────────────
DHT dht(DHT_PIN, DHT_TYPE);

// ── Status LED bawaan ESP32 (GPIO 2) ─────────────────────────
#define LED_PIN 2

// ── Variabel global ───────────────────────────────────────────
unsigned long lastSendTime = 0;
int failCount = 0;

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Koneksi WiFi
// ─────────────────────────────────────────────────────────────
void connectWiFi() {
  Serial.println("\n[WiFi] Menghubungkan ke: " + String(WIFI_SSID));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < WIFI_MAX_RETRY) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] ✓ Terhubung!");
    Serial.println("[WiFi] IP Address: " + WiFi.localIP().toString());
    digitalWrite(LED_PIN, HIGH);  // LED nyala = WiFi OK
  } else {
    Serial.println("\n[WiFi] ✗ Gagal terhubung. Restart dalam 5 detik...");
    delay(5000);
    ESP.restart();
  }
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Baca Sensor DHT22
//  Mengembalikan false jika pembacaan gagal (NaN)
// ─────────────────────────────────────────────────────────────
bool readSensor(float &temperature, float &humidity) {
  // DHT22 butuh ~2 detik antar pembacaan
  humidity    = dht.readHumidity();
  temperature = dht.readTemperature();  // Celsius

  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("[Sensor] ✗ Gagal membaca DHT22. Cek wiring!");
    return false;
  }

  // Validasi range yang masuk akal
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
//  FUNGSI: Kirim Data ke Firebase API
// ─────────────────────────────────────────────────────────────
bool sendTelemetry(float temperature, float humidity) {
  // Reconnect WiFi jika terputus
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Koneksi terputus, reconnecting...");
    connectWiFi();
  }

  // Buat JSON payload
  StaticJsonDocument<128> doc;
  doc["temperature"] = round(temperature * 100.0) / 100.0;  // 2 desimal
  doc["humidity"]    = round(humidity * 100.0) / 100.0;
  doc["device_id"]   = DEVICE_ID;

  String payload;
  serializeJson(doc, payload);

  Serial.println("[HTTP] Mengirim: " + payload);

  // HTTPS client (Firebase butuh SSL)
  WiFiClientSecure client;
  client.setInsecure();  // Skip SSL cert verification
                         // Untuk produksi pakai: client.setCACert(root_ca);

  HTTPClient http;
  http.begin(client, API_ENDPOINT);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);  // 10 detik timeout

  int httpCode = http.POST(payload);
  String response = http.getString();
  http.end();

  if (httpCode == 201) {
    Serial.println("[HTTP] ✓ Berhasil! Code: " + String(httpCode));
    Serial.println("[HTTP] Response: " + response);
    failCount = 0;
    return true;
  } else {
    Serial.println("[HTTP] ✗ Gagal! Code: " + String(httpCode));
    Serial.println("[HTTP] Response: " + response);
    failCount++;

    // Restart ESP32 jika gagal 5x berturut-turut
    if (failCount >= 5) {
      Serial.println("[System] Terlalu banyak kegagalan. Restart...");
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

  // Tampilkan label tetap
  lcd.setCursor(0, 0);
  lcd.write(byte(0));            // Ikon termometer
  lcd.print(" Suhu      : ");

  lcd.setCursor(0, 1);
  lcd.write(byte(1));            // Ikon tetes air
  lcd.print(" Kelembaban: ");

  lcd.setCursor(0, 2);
  lcd.print("  Heat Index: ");

  lcd.setCursor(0, 3);
  lcd.print("--------------------");
}

// ─── Fungsi Update Nilai di LCD ─────────────────
void updateNilaiLCD(float suhu, float kelembaban, float heatIndex) {
  // Baris 0: Suhu
  lcd.setCursor(13, 0);
  if (isnan(suhu)) {
    lcd.print("ERROR  ");
  } else {
    lcd.print(suhu, 1);
    lcd.write(byte(2));  // Simbol derajat
    lcd.print("C ");
  }

  // Baris 1: Kelembaban
  lcd.setCursor(13, 1);
  if (isnan(kelembaban)) {
    lcd.print("ERROR  ");
  } else {
    lcd.print(kelembaban, 1);
    lcd.print("%   ");
  }

  // Baris 2: Heat Index
  lcd.setCursor(13, 2);
  if (isnan(heatIndex)) {
    lcd.print("ERROR ");
  } else {
    lcd.print(heatIndex, 1);
    lcd.write(byte(2));
    lcd.print("C ");
  }
}

// ─────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("╔══════════════════════════════╗");
  Serial.println("║   ClimateOS ESP32 Firmware   ║");
  Serial.println("║   Device: " + String(DEVICE_ID) + "  ║");
  Serial.println("╚══════════════════════════════╝");

  // Inisialisasi sensor
  dht.begin();
  Serial.println("[Sensor] DHT22 diinisialisasi pada GPIO " + String(DHT_PIN));

  // Inisialisasi LCD
  lcd.init();
  lcd.backlight();

  // Daftarkan custom character
  lcd.createChar(0, iconThermo);
  lcd.createChar(1, iconDrop);
  lcd.createChar(2, iconDegree);

  lcd.setCursor(0, 0);
  lcd.print(F("ClimateOS ESP32"));
  lcd.setCursor(0, 2);
  lcd.print(F("Starting..."));
  lcd.setCursor(0, 3);
  lcd.print(F("Connecting to WiFi.."));
  Serial.println(F("[LCD] Diinisialisasi"));

  // Sambungkan ke WiFi
  connectWiFi();

  // Beri waktu sensor untuk stabil
  Serial.println("[System] Menunggu sensor stabil (3 detik)...");
  delay(3000);

  Serial.println("[System] ✓ Siap mengirim data setiap " + String(SEND_INTERVAL_MS / 1000) + " detik.");

  // Tampilkan header intro
  tampilkanHeader();
}

// ─────────────────────────────────────────────────────────────
//  LOOP UTAMA
// ─────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // Kirim data setiap SEND_INTERVAL_MS milidetik
  if (now - lastSendTime >= SEND_INTERVAL_MS || lastSendTime == 0) {
    lastSendTime = now;

    float temperature, humidity;

    // Kedipkan LED saat proses baca+kirim
    digitalWrite(LED_PIN, LOW);

    if (readSensor(temperature, humidity)) {
      Serial.println("─────────────────────────────");
      Serial.println("[Sensor] Suhu     : " + String(temperature, 1) + " °C");
      Serial.println("[Sensor] Kelembaban: " + String(humidity, 1) + " %");

      // Update tampilan LCD
      float heatIndex = dht.computeHeatIndex(temperature, humidity, false);
      updateNilaiLCD(temperature, humidity, heatIndex);

      // Baris 4: Status WiFi
      lcd.setCursor(2, 3);
      if (WiFi.status() == WL_CONNECTED) {
        lcd.print("WiFi: OK-          ");
      } else {
        lcd.print("WiFi: Disconnected-");
      }

      bool success = sendTelemetry(temperature, humidity);

      // LED: nyala solid = OK, kedip cepat = gagal
      if (success) {
        digitalWrite(LED_PIN, HIGH);
      } else {
        for (int i = 0; i < 6; i++) {
          digitalWrite(LED_PIN, !digitalRead(LED_PIN));
          delay(150);
        }
      }
    } else {
      // Update tampilan LCD (menjadi ERROR)
      updateNilaiLCD(NAN, NAN, NAN);

      // Sensor gagal baca — kedip lambat
      for (int i = 0; i < 4; i++) {
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
        delay(400);
      }
    }
  }

  // Yield supaya watchdog timer tidak trigger
  delay(100);
}
