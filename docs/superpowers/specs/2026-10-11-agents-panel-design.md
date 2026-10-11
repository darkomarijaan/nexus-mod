# Nexus v0.6.2: Agents panel (design)

- **Tanggal:** 2026-10-11
- **Status:** desain disetujui per bagian di chat; menunggu tinjauan spec ini
- **Versi target:** v0.6.2 (bersama hitungan git di header HUD)

## 1. Latar belakang dan tujuan

**savvy-progress** (johnnyvizz/claude-kit, MIT) adalah mod yang menampilkan progress bar alur savvy-flow dan panel subagent: status, model, context, token, durasi, langkah yang dilaporkan sendiri, dan biaya dalam dolar. Data per subagent diambil dari `agent.spawn`, `turn.step` dan `turn.complete`.

Nexus sekarang hanya menampilkan jumlah subagent di header (`⚙ 1 agent`) dan daftar ringkas di pane `/sessions-nexus` (tipe, deskripsi, status, sudah jalan berapa lama). Tidak ada model, context, token maupun aktivitas per subagent.

**Tujuan (pilihan C):** pemantauan live **dan** catatan selama sesi.

- Saat subagent berjalan, terutama beberapa sekaligus, terlihat mana yang masih bekerja, mana yang diam terlalu lama, mana yang context-nya hampir penuh, dan mana yang gagal; subagent bisa diarahkan ulang lewat pesan.
- Subagent yang sudah selesai tetap terlihat sampai sesi berakhir: model, jumlah tool, token, durasi, hasil.

**Yang diambil dari savvy-progress:** pelacakan per subagent lewat hook, dan tool laporan langkah (opsional).
**Yang tidak diambil:** biaya dalam dolar (paket Team; keputusan lama "tanpa fitur biaya"), tool `progress` dan fase savvy-flow, animasi SVG, bahasa Rusia.

## 2. Keputusan yang sudah diambil

| Pertanyaan | Keputusan |
|---|---|
| Tujuan panel | C: live dan catatan selama sesi |
| Cara menunjukkan kemajuan | B: pengamatan otomatis (aktivitas terakhir, jumlah tool, context, durasi) **ditambah** tool `step` opsional |
| Daftar subagent di `/sessions-nexus` | B: dibiarkan seperti sekarang; panel ini versi lengkapnya |
| Sumber data | Pendekatan 3: hook untuk data live, ditambah rekonsiliasi dengan `$.agent.list` di polling 4 detik yang sudah ada |
| Kirim pesan ke subagent | Ikut di versi ini (`m`) |
| Tool `step` | Ikut, bisa dimatikan lewat setting `agentSteps` (bawaan on) |

## 3. Arsitektur

- **`hooks/agents.ts`** (baru, pure, dengan unit test): semua logika. Setiap event menjadi fungsi `(runs, input, now) → runs` baru; tidak menyentuh `$`.
- **`hooks/register.tsx`**: wiring tipis. Hook yang sudah ada memanggil fungsi pure lalu `update($, agentRuns, …)`; ditambah pane, perintah, tool `step` dan tombol HUD.
- **State:** satu atom baru `agentRuns: NexusAgentRun[]`, dideklarasikan di `types/index.d.ts`. Hanya untuk sesi ini; tidak disimpan ke `$.store`.

### 3.1 Record per subagent

```ts
type NexusAgentRun = {
  id: string                 // agentId
  type: string               // subagentType, mis. "Explore", "code-reviewer"
  description: string
  model: string              // dari agent.spawn, diperbarui oleh usage
  status: 'running' | 'done' | 'failed' | 'ended'
  startedAt: number
  endedAt: number | null
  tools: number              // jumlah tool call
  lastTool: string | null    // mis. "Bash"
  lastDetail: string | null  // mis. "npm test" (describeInput)
  lastActivityAt: number     // waktu tool call terakhir, atau mulai
  contextTokens: number      // input + cache read + cache creation + output dari request terakhir
  tokens: number             // jumlah semua request
  step: { done: number; total: number; note: string | null } | null
}
```

`ended` berarti hilang dari daftar engine tanpa `turn.complete` yang terlihat (misalnya subagent dari sebelum `/reload-plugins`).

### 3.2 Event dan fungsi pure

| Event (hook yang sudah ada) | Fungsi pure | Efek |
|---|---|---|
| `agent.spawn`, setelah `next`, kalau tidak `deny` (hook subagent cap) | `onSpawn(runs, { agentId, type, description, model }, now)` | record baru, `running` |
| `tool.call` dengan `e.agentId` (hook Guards) | `onToolCall(runs, { agentId, tool, detail }, now)` | `tools + 1`, `lastTool`, `lastDetail`, `lastActivityAt` |
| `turn.step` dengan `e.agentId` (hook speed) | `onUsage(runs, { agentId, model, usage })` | `contextTokens`, `tokens +=`, `model` |
| `turn.complete` dengan `e.agentId` (hook akhir giliran) | `onComplete(runs, { agentId, isOk }, now)` | `done` atau `failed`, `endedAt` |
| tool `step` dari subagent | `onStep(runs, { agentId, done, total, note }, now)` | `step` dirapikan; `lastActivityAt` |
| `refreshHud` (polling 4 detik, sudah memanggil `$.agent.list`) | `reconcile(runs, list, now)` | tambah yang tidak tercatat (data dasar); `running` yang tidak ada di daftar menjadi `ended` |

Event untuk `agentId` yang belum dikenal membuat record dasar (tipe dan deskripsi `unknown` sampai rekonsiliasi mengisinya). Maksimal **50 record**; yang dibuang lebih dulu adalah record yang sudah selesai dan paling lama.

### 3.3 Fungsi tampilan (pure)

- `contextWindowOf(model)`: `1_000_000` kalau nama model memuat `[1m]`, selain itu `200_000`. Perkiraan; angka token selalu ditampilkan.
- `isQuiet(run, now)`: `running` dan lebih dari **2 menit** tanpa tool call atau laporan `step`.
- `agentSummary(runs)`: judul panel, mis. `2 running · 2 done · 1 failed · 214k tokens`.
- `agentRowText(run, now, width)`: teks baris (lihat 4.1).

## 4. Tampilan dan interaksi

### 4.1 Panel `PANE.agents`

```
Agents · 2 running · 2 done · 1 failed · 214k tokens
Running
1 ● code-reviewer  Review the coupon module                 2m 14s
    opus-5-5 · ctx ▰▰▰▱▱▱▱▱ 41k · 12 tools · step 3/5 writing tests
    ⟳ Bash  npm test
2 ● Explore        Find every coupon call site      ⚠ quiet 3m 05s
    haiku-5-5 · ctx ▰▱▱▱▱▱▱▱ 18k · 7 tools
    ⟳ Grep  applyCoupon

Finished
3 ✓ Explore        Map the checkout flow     48s · haiku · 9 tools · 31k
4 ✓ Plan           Draft the migration      1m 20s · opus · 4 tools · 52k
5 ✗ general        Migrate schema           1m 02s · sonnet · failed

1-9: pick an agent · m: message it · Esc close
```

- Subagent yang berjalan: 3 baris (judul; model, context, tool, langkah; aktivitas terakhir). Yang selesai: 1 baris.
- `⚠ quiet` berwarna warn; bar context berwarna bad di atas 80% dari perkiraan window.
- Warna, bar dan ikon dari skin aktif (`themedBar`, `ThemeIcons`).
- Tanpa subagent: "No subagent has run in this session yet."

### 4.2 Membuka panel

- **`/agents-nexus`** (perintah baru, `immediate: true`).
- **Tombol `a: Agents`** di action bar HUD, hanya kalau `agentRuns` tidak kosong.
- **Tidak terbuka sendiri.**

### 4.3 Kirim pesan

`1`–`9` memilih baris; `m` membuka Input; Enter mengirim lewat `$.session.send({ to: { agentId }, text })`. Hanya untuk subagent yang `running`. Gagal kirim memunculkan toast dengan alasannya. Tidak ada cara menghentikan subagent secara paksa di API mod 2.1.296.

## 5. Tool `step` dan setting

- **Nama:** `step`, jadi `mcp__nexus__step`. Didaftarkan di `session.start` kalau `agentSteps` on.
- **Deskripsi (untuk model):** untuk subagent saja; setelah membaca tugas, panggil dengan `total` (3–8 langkah) dan `done: 0`, lalu setiap langkah selesai; murah dan diam, hanya menggambar bar.
- **Input:** `done` (wajib, ≥ 0), `total` (≥ 1), `note` (beberapa kata).
- **Tanpa `agentId`** (thread utama): dijawab `ignored: only subagents report steps`, tidak mengubah apa pun.
- **Biaya:** definisi tool sekitar 100 token di setiap request, ditambah satu giliran tool per panggilan.
- **Setting `agentSteps`** (boolean, bawaan `true`), judul "Agent step reports". Aturan tiga tempat: `userConfig` di `.claude-plugin/plugin.json`, `NexusConfig` dan `readConfig` di `hooks/config.ts`, baris di `statusText`; plus tabel Settings di README. Kalau off, tool tidak didaftarkan dan panel memakai pengamatan saja.

## 6. Penanganan error

- Pencatatan di hook dijalankan **setelah `next`** dan dibungkus `catch`: kalau gagal, tool call dan giliran subagent tetap berjalan normal.
- `step` dengan angka di luar rentang dirapikan: `total` minimal 1, `done` antara 0 dan `total`, `note` dipotong.
- Kirim pesan yang ditolak engine: toast dengan alasannya; tidak ada state yang berubah.
- Rekonsiliasi tidak pernah menghapus record; hanya menambah atau menandai `ended`.

## 7. Pengujian

`tests/agents.test.ts`, ditulis dulu sampai gagal (TDD).

**Pure**
- `onSpawn`, `onToolCall`, `onUsage`, `onComplete`, `onStep`: masing-masing satu perubahan yang diharapkan; `agentId` tidak dikenal membuat record dasar.
- `reconcile`: menambah yang tidak tercatat; `running` yang hilang menjadi `ended`; record selesai tidak berubah.
- Batas 50: yang dibuang adalah yang selesai paling lama, bukan yang `running`.
- `isQuiet` di batas 2 menit; `contextWindowOf`; perapian `step`; `agentSummary`; `agentRowText` (lebar sempit dan lebar).

**Integrasi** (engine disimulasikan dengan `on(...)`)
- Urutan `agent.spawn` → `tool.call` (dengan `agentId`) → `turn.step` → `turn.complete`, lalu pane di-mount: baris berisi tipe, model, jumlah tool, aktivitas terakhir, status selesai.
- Tool `step` dari subagent mengisi langkah; dari thread utama diabaikan.
- `agentSteps: false`: tool tidak terdaftar.
- Tombol `a` di HUD tidak ada sebelum subagent pertama, ada sesudahnya.
- `1` lalu `m` lalu kirim: `session.send` menerima `agentId` yang benar.

Lalu `claude plugin test .`, `claude plugin validate .`, dan type-check strict.

## 8. Di luar lingkup

Biaya dalam dolar; panel terbuka sendiri; menghentikan subagent secara paksa; riwayat lintas sesi; progress bar alur savvy-flow; perubahan pada pane `/sessions-nexus`.

## 9. Berkas yang disentuh

| Berkas | Perubahan |
|---|---|
| `hooks/agents.ts` | baru: logika pure |
| `tests/agents.test.ts` | baru |
| `hooks/register.tsx` | wiring di hook `agent.spawn`, `tool.call`, `turn.step`, `turn.complete`, `refreshHud`; tool `step`; `/agents-nexus`; pane; tombol `a` |
| `hooks/state.ts` | `PANE.agents` |
| `types/index.d.ts` | `NexusAgentRun`, atom `agentRuns` |
| `hooks/config.ts`, `.claude-plugin/plugin.json` | setting `agentSteps` |
| `README.md` | bagian fitur, Commands, Keys (`a`), Settings |

Kredit: pendekatan pelacakan per subagent dan tool laporan langkah terinspirasi dari savvy-progress (MIT); ditulis ulang dengan gaya Nexus.
