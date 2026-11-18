# Auto Model + Jev: klasifikasi tier lewat model TypeSafe (rancangan)

Status: rancangan, belum dibangun. Tanggal: 2026-11-18.

## Masalah

Auto Model memilih tier (Haiku, Sonnet, Opus) dengan regex atas pesan terakhir
(`bridge/claude-mode.mjs`, `classify`). Murah dan tanpa panggilan jaringan, tapi
kasar: kata seperti `delete` atau `error` menaikkan tier tanpa alasan, dan pesan
yang ambigu jatuh ke MEDIUM. Log sesi nyata menunjukkan beberapa salah tebak
(sebagian sudah diperbaiki di 0.6.9).

## Jev, yang sudah dipastikan dari dokumentasinya

Sumber: docs.typesafe.ai (introduction, quickstart, confidence, primitives/choice).

- Jev adalah model TypeSafe yang menjawab pertanyaan bertipe terhadap sebuah
  `state`, tanpa menghasilkan teks bebas.
- Panggilan: `POST https://api.typesafe.ai/v1/systemone`, header
  `Authorization: Bearer <API_KEY>` dan `Content-Type: application/json`. Kunci
  dari console.typesafe.ai/keys; SDK membaca `TYPESAFE_API_KEY`.
- Badan permintaan: `state` (string atau objek), `model` (contoh `jev-latest`),
  `questions` (peta id → pertanyaan). Pertanyaan Choice:
  `{ "type": "choice", "instructions": "...", "criteria": { "<opsi>": "<deskripsi>" } }`.
- Jawaban: `answers.<id>.choice`, `probabilities` (jumlahnya 1), `confidence`
  (0 sampai 1), dan `usage.input_tokens` / `usage.output_tokens`.
- `confidence` untuk Choice = (p_maks − 1/n) / (1 − 1/n). Dokumentasinya sendiri
  menyarankan memakai probabilitas opsi yang akan diambil, bukan confidence saja,
  dan menyetel ambang dengan data sendiri.

### Akses lewat Command Code (contoh dari pemilik)

Jev juga bisa diakses lewat provider Command Code, dengan badan permintaan yang
sama tapi alamat, kunci, dan model id berbeda:

```
curl https://api.commandcode.ai/provider/v1/systemone \
  -H "Authorization: Bearer <CMD_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model": "typesafe/jev-1.14.0", "state": "Payments failed for three days.",
       "questions": {"urgent": {"type": "noul", "instructions": "Does this need urgent attention?"}}}'
```

Akibatnya untuk rancangan:

- Alamat, nama variabel lingkungan kunci, dan model id jadi setelan, bukan
  konstanta. Default mengikuti jalur yang dipakai pemilik: Command Code,
  `CMD_API_KEY`, `typesafe/jev-1.14.0` (versi disematkan, bukan `-latest`).
- Penerima teks jadi dua pihak: Command Code dan TypeSafe di belakangnya.
  Kebijakan data keduanya perlu dibaca.
- Bentuk jawaban lewat Command Code belum dipastikan sama persis dengan
  dokumentasi TypeSafe. `parseAnswer` harus toleran dan menolak (kembali ke
  regex) bentuk yang tidak dikenal; langkah 0 memastikannya dengan satu
  panggilan nyata.
- Contoh di atas memakai pertanyaan `noul` (ya atau tidak, dengan probabilitas
  sebagai nilainya). Itu bisa jadi varian yang lebih sederhana: satu `noul`
  "Apakah ini butuh penalaran mendalam?" untuk memutuskan HEAVY. Tapi untuk tiga
  tier, satu Choice tetap lebih tepat.

## Yang belum diketahui (harus diukur atau dibaca sebelum membangun)

- Latensi dalam milidetik, terutama dari Indonesia. Dokumentasi hanya bilang
  pertanyaan dievaluasi paralel.
- Batas laju, harga, kebijakan retensi data, dan apakah data kiriman dipakai
  untuk pelatihan. Tidak disebut di tiga halaman itu. Halaman API reference
  (docs.typesafe.ai/api) dan halaman SDK belum dibaca.
- Apakah `jev-latest` stabil antar hari (perlu menyematkan versi).

## Batasan yang tidak boleh dilanggar

0. **Jev tidak pernah wajib.** Nexus dipakai publik, dan tidak semua orang punya
   akses ke Jev (Command Code atau TypeSafe). Tanpa Jev, Auto Model bekerja
   persis seperti sekarang: klasifikasi regex di `classify`, tanpa langkah
   tambahan.
   - `autoModelJev` bawaannya `off`. Dalam keadaan itu tidak ada kode Jev yang
     dijalankan, tidak ada panggilan jaringan, dan tidak ada pesan apa pun.
   - Kalau `autoModelJev` dinyalakan tapi kuncinya tidak ada (variabel tidak
     diisi atau kosong): Jev tidak dipanggil, regex dipakai, tidak ada error dan
     tidak ada peringatan berulang. `/automodel-nexus` menulis satu baris
     (`Jev: no key, using rules`) supaya orang tahu mengapa.
   - Semua kegagalan Jev (timeout, jaringan, 401/403, 4xx/5xx, jawaban asing)
     berakhir di regex, bukan di kesalahan untuk pengguna.
   - Tidak ada dependensi baru, tidak ada kunci atau alamat Jev di repo, dan
     README menyebut fitur ini sebagai tambahan opsional untuk yang punya
     aksesnya. Alamat dan model id adalah setelan, jadi layanan lain yang
     bentuk permintaannya sama bisa dipakai.
   - Router yang dimulai tanpa setelan Jev sama sekali (misalnya plugin lama)
     tetap jalan: bidang `jev` pada pengaturan boleh tidak ada.
1. **Privasi, opt-in.** Sekarang router tidak mengirim teks prompt ke luar
   Anthropic, dan README menyatakan hanya kode alasan yang disimpan. Jev
   menambah penerima baru. Mati secara default, dengan keterangan jelas di
   README dan di `/automodel-nexus`.
2. **Kunci tidak masuk repo.** Repo ini publik. Kunci dibaca router dari
   variabel lingkungan `TYPESAFE_API_KEY` milik proses `claude-nexus`, tidak
   pernah dari `plugin.json`, state, atau log.
3. **Tidak boleh memperlambat atau merusak giliran.** Setiap kegagalan Jev
   (timeout, jaringan, 4xx/5xx, JSON rusak, confidence rendah) berarti kembali
   ke regex, diam-diam, tanpa mengubah request.
4. **Satu panggilan per giliran.** Keputusan sudah lengket per giliran (kunci
   `turn.key`); lanjutan tool-result memakai hasil yang sama.

## Rancangan

### Kapan Jev dipanggil

Hanya di zona abu-abu: skor regex 0 sampai 4 (satu langkah dari tiap batas
LIGHT/MEDIUM/HEAVY). Skor ≤ −1 (jelas ringan) atau ≥ 5 (jelas berat) tidak
memanggil Jev. Rentang ini adalah tebakan awal; ukur berapa persen giliran yang
masuk zona itu sebelum menetapkannya.

### Apa yang dikirim

Hanya teks yang diketik orang (`typed()`: tanpa system-reminder dan tanpa
bungkus slash command), dipotong 2000 karakter pertama + 500 terakhir. Tidak
pernah: hasil tool, system prompt, isi berkas, riwayat percakapan. Kalau teks
cocok pola rahasia (kunci API, token, blok kunci privat), Jev dilewati dan regex
dipakai (gagal tertutup).

### Pertanyaan

Satu Choice dengan tiga opsi:

- `LIGHT`: pertanyaan faktual singkat, perubahan mekanis kecil, ringkasan atau terjemahan.
- `MEDIUM`: pekerjaan koding sehari-hari dengan ruang lingkup jelas.
- `HEAVY`: arsitektur, analisis akar masalah, perubahan lintas banyak berkas,
  keputusan dengan trade-off, atau pekerjaan berisiko tinggi.

### Menggabungkan dengan regex

- `jawaban.confidence ≥ minConfidence` (awal 0,5) dan probabilitas opsi terpilih
  ≥ 0,6: pakai level Jev.
- Selain itu: level regex.
- Lantai risiko: kalau regex menandai `risk`, level tidak turun di bawah MEDIUM
  walau Jev bilang LIGHT.
- Kode alasan baru: `jev:HEAVY@0.84`, `jev-low-conf`, `jev-timeout`,
  `jev-error`, `jev-skip-secret`.

### Kegagalan dan pengaman

- Timeout (awal 1500 ms, lihat hasil ukur) lewat `AbortSignal`.
- Pemutus sirkuit: tiga kegagalan beruntun menjeda Jev 5 menit.
- 401 atau 403 mematikan Jev sampai `/automodel-nexus reset`, dan status
  menyebut alasannya.
- Panggilan Jev tidak pernah melewati rantai fallback model Anthropic.

### Struktur kode

- `bridge/jev.mjs` (baru, logika murni): `buildRequest(text)`,
  `parseAnswer(json)` → `{ level, confidence, probabilities, usage } | null`,
  `looksSecret(text)`, dan `askJev({ fetch, key, timeoutMs, text })`.
- `classify(turn, { bytes, hint })` tetap sinkron dan murni; `hint` adalah hasil
  Jev bila ada. Router yang `await` Jev sebelum memanggil `plan()`, hanya bila
  `mode.wantsJev(turn)` benar (zona abu-abu, belum ada hasil untuk `turn.key`).
- `createClaudeMode` menyimpan hitungan: panggilan, dipakai, confidence rendah,
  timeout, error, token. Muncul di `snapshot` dan `/automodel-nexus`.
- Sisi hook (`register.tsx` tetap tipis): `modePayload` meneruskan
  `jev: { enabled, timeoutMs, minConfidence }`; `snapshot` melaporkan
  `jev.keyPresent` (boolean saja, tidak pernah kuncinya).

### Setelan baru (tiga tempat: `plugin.json`, `config.ts`, `/nexus` status, plus README)

- `autoModelJev`: `off` (default) | `gray`.
- `autoModelJevUrl`: `https://api.commandcode.ai/provider/v1/systemone`.
- `autoModelJevKeyEnv`: `CMD_API_KEY` (nama variabelnya, bukan kuncinya).
- `autoModelJevModel`: `typesafe/jev-1.14.0`.
- `autoModelJevTimeoutMs`: 1500.
- `autoModelJevMinConfidence`: 0,5.

Router hanya mengirim ke alamat `https` (sama seperti aturan hub yang ada), dan
kunci dibaca dari variabel yang dinamai `autoModelJevKeyEnv` di proses
`claude-nexus`.

### Pengujian

Kasus "tanpa Jev" diuji lebih dulu dan harus identik dengan perilaku sekarang:
setelan `off`; `gray` tanpa kunci; `gray` dengan kunci kosong; bidang `jev` tidak
ada di pengaturan; dan semua test klasifikasi yang ada tetap lulus tanpa
perubahan. Selain itu, `node:test` dengan server HTTP palsu sebagai `api.typesafe.ai`: override saat
confidence tinggi, kembali ke regex saat rendah, timeout, 401 mematikan Jev,
pemutus sirkuit, satu panggilan per giliran, pemotongan teks, teks berisi
rahasia tidak dikirim, lantai risiko, dan kunci tidak pernah muncul di
snapshot atau log.

## Langkah 0: ukur dulu sebelum membangun

1. Dengan kunci Command Code, jalankan `curl` di atas dari komputer Anda,
   tapi dengan pertanyaan Choice tiga tier. Catat latensi (p50 dan p95 dari
   sekitar 20 panggilan) dan bentuk jawabannya.
2. Kumpulkan 30 sampai 50 pesan nyata yang sudah diberi label tier oleh Anda,
   lalu bandingkan akurasi regex dan Jev. Kalau Jev tidak jelas lebih baik, atau
   p95 di atas sekitar 1 detik, berhenti di sini.
3. Baca docs.typesafe.ai/api dan halaman kebijakan data mereka.

## Alternatif yang perlu dibandingkan

Pengklasifikasi Haiku (satu panggilan kecil lewat rute Claude yang sama): teks
tetap hanya ke Anthropic, tanpa penerima baru dan tanpa kunci tambahan, tapi
memakai kuota langganan, menambah latensi, dan hasilnya teks yang harus
di-parse. Antarmuka `hint` di atas membuat kedua pengklasifikasi bisa dipasang
bergantian, jadi pilihan ini bisa diputuskan setelah langkah 0.

## Keputusan yang diminta dari pemilik

1. Apakah mengirim teks pesan ke Command Code (dan TypeSafe di belakangnya) bisa diterima, selama opt-in?
2. Zona abu-abu awal (skor 0 sampai 4) dan timeout 1500 ms: setuju sebagai titik mulai?
3. Mau jalankan langkah 0 dulu, atau langsung membangun di balik setelan `off`?

## Hasil ukur langkah 0 (2026-11-18, dari komputer pemilik, Command Code, `typesafe/jev-1.14.0`)

20 panggilan Choice tiga tier, semuanya HTTP 200.

- **Latensi:** p50 738 ms, p95 1167 ms, maks 1167 ms (yang paling lambat adalah
  panggilan pertama, kemungkinan karena membuka koneksi). Rentang normal 680
  sampai 800 ms.
- **Bentuk jawaban** sama dengan dokumentasi TypeSafe: `answers.tier.choice`,
  `confidence`, `probabilities`, dan `usage` (sekitar 376 token masuk dan 41
  keluar per panggilan, sebagian besar adalah instruksi dan deskripsi opsi yang
  tetap).
- **Pilihan:** lima pesan contoh, masing-masing diulang empat kali, selalu sama:
  "jam berapa sekarang?" → LIGHT (0,94), "fix typo in README" → LIGHT (0,98 sampai 1),
  "Tambah fungsi untuk validasi email" → MEDIUM (0,56 sampai 0,61), arsitektur
  microservice → HEAVY (1), race condition → HEAVY (0,96 sampai 0,97).
- **Konsekuensi untuk rancangan:**
  - Timeout awal 800 ms terlalu ketat: p50 sudah 738 ms, jadi sekitar separuh
    panggilan akan habis waktu. Dinaikkan ke 1500 ms. Panggilan ini menambah
    sekitar 0,7 detik pada giliran yang masuk zona abu-abu, jadi zonanya harus
    sempit dan koneksi dipakai ulang (keep-alive).
  - `confidence` untuk MEDIUM berkisar 0,56 sampai 0,61, dekat ambang 0,5. Pakai
    probabilitas opsi terpilih (dokumentasi juga menyarankannya), bukan
    `confidence` saja, dan setel ambangnya dengan data nyata.
- **Yang belum terbukti:** lima pesan itu mudah dan hanya diulang. Akurasi pada
  pesan nyata yang ambigu belum diuji. Retensi dan kebijakan data Command Code
  dan TypeSafe belum dibaca.
