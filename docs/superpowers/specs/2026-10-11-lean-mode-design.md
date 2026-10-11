# Nexus v0.6: Lean mode (design)

- **Tanggal:** 2026-10-11
- **Status:** desain disetujui per bagian di chat; menunggu tinjauan spec ini
- **Versi target:** v0.6 (rencana "Jujur" bergeser ke v0.7)

## 1. Latar belakang dan tujuan

Dua plugin populer mengubah perilaku Claude Code hanya lewat aturan teks:

- **Caveman** (JuliusBrussee/caveman): jawaban super ringkas untuk memangkas token output. Benchmark mereka sendiri: hanya 3% lebih hemat dari instruksi "Answer concisely" di median, 35% untuk level ultra; uji independen 15–25%. Aturannya memakan ±1.160 token.
- **Ponytail** (DietrichGebert/ponytail, MIT): "tangga keputusan" sebelum menulis kode supaya hasilnya minimal. Klaim benchmark mereka: −53% kode, −45% token.

Nexus sudah punya mekanismenya: hook `prompt.compose` memasang bagian "Delivery (Nexus)" ke system prompt (`hooks/register.tsx`, `deliveryRules`), dan `trimOutput` (v0.4.0) sudah memampatkan output perintah seperti proxy Caveman.

**Tujuan:** hemat kuota/token dan kode hasil Claude lebih ramping, dengan aturan versi Nexus sendiri yang ringkas, menyala dari awal, dan bisa diatur di tengah sesi.

**Kriteria sukses**

1. Dengan setting bawaan, jawaban Claude tanpa basa-basi dan rekap, dan kode baru melewati tangga keputusan, tanpa pengguna menyalakan apa pun.
2. `/lean-nexus` mengubah level di tengah sesi, berlaku mulai giliran berikutnya, dan diingat antar-sesi.
3. Tiga judul Executive Summary tetap ada, sehingga next-step suggestion dan commit helper tetap jalan.
4. `/lean-review-nexus` menunjuk bagian over-engineered pada perubahan tanpa mengubah file.
5. `/compress-nexus` memadatkan CLAUDE.md tanpa kehilangan blok kode, path, URL, atau angka, dan selalu dengan backup.
6. Aturan lean di system prompt tidak lebih dari ±400 token untuk kombinasi terbesar.

**Di luar cakupan**

- Proxy pemampat output ala Caveman (sudah ditangani `trimOutput`).
- Gaya 文言文 (`/megacave`), subagent khusus, statistik penghematan lintas sesi.
- Menulis ulang prompt pengguna (Caveman sendiri menghindarinya; memperburuk jawaban).
- Menyalin teks aturan Caveman/Ponytail; aturan ditulis sendiri.

## 2. Arsitektur

```
plugin.json userConfig ─┐
                        ├─► leanSettings() ─► leanRules() ─► prompt.compose section "nexus:delivery"
atom leanPick (override)┘                                    (satu section bersama Executive Summary dan Design Lens)
/lean-nexus ──► parseLeanArgs() ──► atom leanPick
/lean-review-nexus ──► git diff ──► $.prompt.submit (Claude utama)
/compress-nexus ──► $.model.complete (helperModel) ──► checkCompressed() ──► dialog ──► backup + tulis
```

- **`hooks/leanmode.ts` (baru, murni, tanpa `$`):** teks aturan per level, Executive Summary versi padat, parser argumen `/lean-nexus`, prompt review, prompt kompres, `checkCompressed`, estimasi token.
- **`hooks/register.tsx`:** sambungan saja: atom, `prompt.compose`, tiga command, badge HUD, baris `/nexus`, angka footer.
- **`hooks/config.ts`:** dua kolom baru.

## 3. Aturan per level

Teks aturan berbahasa Inggris (hemat token, paling dipatuhi) dan berlaku untuk bahasa apa pun yang dipakai pengguna.

### 3.1 Bicara `lite` (bawaan)

- Jawaban di depan; tanpa salam, mengulang pertanyaan, penutup ("hope this helps", tawaran bantuan).
- Tanpa rekap di sela tool call; paling banyak satu baris pendek bila berguna.
- Kalimat pendek, tanpa pengisi dan basa-basi, tidak mengulang yang sudah tampil.
- Kode, perintah, path, pesan error, angka: persis.
- Pengecualian (kalimat lengkap dan jelas): peringatan keamanan, aksi yang tidak bisa dibatalkan, instruksi langkah demi langkah, pertanyaan ke pengguna, pengguna tampak bingung.

### 3.2 Bicara `ultra`

`lite` ditambah: gaya telegram (fragmen boleh, satu ide per baris, kata sambung/pengisi dibuang, `→` boleh). Kata negasi wajib tetap ada (not/no/never/only; tidak/bukan/jangan/hanya, dan padanannya di bahasa lain).

### 3.3 Kode minimal `on` (bawaan)

Baca dulu kode yang disentuh, lalu berhenti di anak tangga pertama yang cukup:

1. Perlu ada sama sekali?
2. Sudah ada di codebase? Pakai.
3. Library standar?
4. Fitur bawaan platform?
5. Dependensi yang sudah terpasang? Dependensi baru hanya setelah bertanya.
6. Bisa satu baris?
7. Versi minimal yang berfungsi.

Tidak pernah dipangkas: validasi di batas kepercayaan, penanganan kehilangan data, keamanan, aksesibilitas. Logika dengan cabang, loop, parsing, uang, atau keamanan mendapat satu test kecil.

### 3.4 Executive Summary versi padat

Berlaku saat `executiveSummary` aktif dan bicara bukan `off`. Tiga judul tetap (**What Changed**, **Verification Status**, **Next Steps**):

- What Changed: satu baris pendek per file.
- Verification Status: satu baris, ditambah yang dilewati/tidak dicek (dari kode minimal bila aktif).
- Next Steps: satu baris atau "None".

Bicara `off` → Executive Summary versi lengkap seperti sekarang. Executive Summary mati → aturan bicara tetap berlaku, tanpa judul.

### 3.5 Susunan di system prompt

Satu section `nexus:delivery` (id tetap, `scope: 'session'`) berisi, berurutan: Executive Summary (lengkap atau padat), aturan bicara, aturan kode, Design Lens. Bagian yang mati tidak ditulis. Semua mati → section tidak dipasang.

## 4. Setting dan command

### 4.1 Setting

| Kolom `userConfig` | Tipe | Pilihan | Bawaan |
|---|---|---|---|
| `leanTalk` ("Bicara ringkas") | string | `off`, `lite`, `ultra` | `lite` |
| `leanCode` ("Kode minimal") | boolean | | `true` |

Atom `leanPick` (`{ plugin: 'nexus', key: 'lean' }`, nilai `{ talk?, code? }` atau kosong) diingat antar-sesi dan mengalahkan Settings per kolom. Nilai tidak valid di atom diabaikan (ikut Settings).

### 4.2 `/lean-nexus` (immediate)

| Argumen | Efek |
|---|---|
| (kosong) | Status `Bicara: lite · Kode minimal: on` (+ `(override)` bila dari atom) dan contoh pemakaian |
| `talk off\|lite\|ultra` | Ubah bicara |
| `code on\|off` | Ubah kode minimal |
| `off` | Keduanya mati |
| `on` | `talk lite`, `code on` |
| `reset` | Kosongkan atom (ikut Settings) |
| lainnya | Ditolak dengan daftar pilihan valid; tidak ada yang berubah |

Setiap perubahan menjawab satu baris tambahan: "Berlaku mulai giliran berikutnya; cache prompt ter-reset sekali."

### 4.3 `/lean-review-nexus [base]`

1. Bukan repo git → pesan, selesai.
2. Tanpa `base`: `git diff HEAD` (staged dan belum staged) plus daftar file untracked dari `git status --porcelain`; dengan `base`: `git diff <base>`. Error git → tampilkan pesan git, selesai.
3. Diff kosong → "Tidak ada perubahan untuk direview", selesai.
4. Diff ≤ 40.000 karakter → dikirim utuh; lebih besar → hanya `git diff --stat` dan daftar file, Claude membuka file sendiri.
5. `$.prompt.submit` ke Claude utama dengan prompt review: nilai perubahan dengan tangga §3.3, laporkan `file:baris`, anak tangga yang dilanggar, alternatif lebih sederhana; jangan ubah file kecuali diminta; tidak ada temuan → katakan begitu.

### 4.4 `/compress-nexus [file]`

1. Target: argumen (mendukung `~`) atau `CLAUDE.md` di root project. Tidak ada/kosong → ditolak.
2. `$.model.complete` dengan `helperModel` dan prompt kompres: buang pengisi, jaga persis blok kode, perintah, path, URL, angka, judul, dan urutan.
3. `checkCompressed(original, result)` menolak bila: ada blok kode yang berubah/hilang; ada path, URL, atau angka dari file asli yang hilang; hasil tidak lebih pendek; hasil < 30% panjang asli. Pesan penolakan menyebut alasan dan maksimal tiga contoh.
4. Dialog: estimasi token sebelum → sesudah (`≈`, karakter/4) dan persen, cuplikan perbandingan; tombol **Tulis** / **Batal**.
5. Tulis: baca ulang file; berubah sejak langkah 2 → batal dengan pesan. Tulis backup `<file>.bak-YYYYMMDD-HHMMSS`; gagal → batal tanpa menimpa. Lalu tulis hasil.

## 5. HUD, status, footer

- **Badge HUD** di sebelah badge provider: `✂ lite · min`, `✂ ultra`, `✂ min`, `✂ lite`; tidak tampil bila keduanya mati. Skin `ascii`: `[lean]` menggantikan `✂`.
- **`/nexus`:** baris `Lean talk  <level>` dan `Lean code  on|off`, dengan `(override)` bila dari atom.
- **Turn footer:** angka token output giliran itu (`out 1,2k`) bila tersedia dari API plugin; kalau tidak tersedia, dilewati.

## 6. Penanganan error

| Kasus | Perilaku |
|---|---|
| Argumen `/lean-nexus` tidak dikenal | Ditolak, setting tetap |
| Atom rusak | Diabaikan, ikut Settings |
| Bukan repo git / `base` salah | Pesan, Claude tidak dipanggil |
| Diff besar | Hanya stat + daftar file |
| Helper model gagal | Pesan, file tidak disentuh |
| `checkCompressed` gagal | Pesan berisi alasan, tidak ada dialog |
| File berubah sebelum Tulis | Batal dengan pesan |
| Backup gagal | Batal, file asli tidak ditimpa |
| Pembuatan teks aturan melempar error | Bagian lean dilewati; giliran tetap jalan |

## 7. Pengujian

`tests/leanmode.test.ts` (pola `claude-code/testing`, seperti `tests/lean.test.ts`):

- Teks aturan untuk setiap kombinasi talk × code: frasa kunci ada; `ultra` memuat aturan negasi; semua mati → string kosong; kombinasi terbesar ≤ 1.600 karakter (±400 token).
- Executive Summary padat hanya saat talk aktif dan tetap memuat tiga judul; jawaban contoh berformat padat masih dibaca benar oleh parser next-step yang ada.
- `parseLeanArgs`: semua bentuk valid dan penolakan typo.
- `checkCompressed`: blok kode hilang, path hilang, angka berubah, tidak lebih pendek, susut > 70% ditolak dengan alasan tepat; satu kasus lolos.

Lewat hook (mock seperti `tests/nexus.test.ts`):

- `prompt.compose` memasang aturan sesuai setting; tidak memasang apa pun bila semua mati.
- Override atom mengalahkan Settings; `reset` mengembalikan.
- `/lean-review-nexus` tanpa perubahan atau di luar git tidak memanggil `$.prompt.submit`.
- `/compress-nexus`: helper error atau Batal → tidak ada tulis; Tulis → backup ditulis sebelum file.

Manual: pertanyaan sama dengan off/lite/ultra dan bandingkan `out` di footer; `/lean-review-nexus` pada perubahan yang sengaja berlebihan; `/compress-nexus` pada salinan CLAUDE.md.

## 8. Risiko yang diverifikasi paling awal

1. `prompt.compose` dihitung ulang tiap permintaan, sehingga perubahan `/lean-nexus` berlaku di giliran berikutnya tanpa restart. Kalau tidak, catatan di §4.2 diganti "berlaku di sesi berikutnya".
2. Token output per giliran tersedia untuk footer. Kalau tidak, angka footer dilewati (§5).
3. API dialog dengan tombol (pola yang sudah dipakai rollback) tersedia untuk `/compress-nexus`.

## 9. Berkas yang disentuh

| Berkas | Perubahan |
|---|---|
| `hooks/leanmode.ts` | Baru |
| `hooks/register.tsx` | Atom, `prompt.compose`, tiga command, badge, `/nexus`, footer |
| `hooks/config.ts` | `leanTalk`, `leanCode` |
| `.claude-plugin/plugin.json` | Dua kolom `userConfig`, versi 0.6.0 |
| `tests/leanmode.test.ts` | Baru |
| `README.md`, `CHANGELOG.md` | Dokumentasi fitur |
