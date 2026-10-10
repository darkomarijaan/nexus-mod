import type { NexusDesign, NexusDesignOption } from '../types'

const escape = (text: string) =>
  text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)

const cssValue = (text: string) => text.replace(/[;{}<>]/g, '')

export function isHex(color: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color.trim())
}

export function tokensOf(option: NexusDesignOption): Record<string, unknown> {
  return {
    name: option.name,
    ...(option.colors === undefined ? {} : { colors: option.colors }),
    ...(option.fonts === undefined ? {} : { fonts: option.fonts }),
    ...(option.radius === undefined ? {} : { radius: option.radius }),
    ...(option.spacing === undefined ? {} : { spacing: option.spacing }),
  }
}

function cardVars(option: NexusDesignOption): string {
  const vars = Object.entries(option.colors ?? {}).map(
    ([name, value]) => `--c-${name.replace(/[^a-zA-Z0-9-]/g, '-')}: ${cssValue(value)};`,
  )
  if (option.fonts?.heading) vars.push(`--font-heading: ${cssValue(option.fonts.heading)};`)
  if (option.fonts?.body) vars.push(`--font-body: ${cssValue(option.fonts.body)};`)
  if (option.radius) vars.push(`--radius: ${cssValue(option.radius)};`)
  if (option.spacing) vars.push(`--space: ${cssValue(option.spacing)};`)

  return vars.join(' ')
}

function defaultSample(option: NexusDesignOption): string {
  const colors = Object.values(option.colors ?? {})
  const bg = colors[0] ?? '#ffffff'
  const fg = colors[1] ?? '#111111'
  const accent = colors[2] ?? colors[1] ?? '#3355ff'

  return `<div style="background:${cssValue(bg)};color:${cssValue(fg)};padding:20px;border-radius:var(--radius,10px);font-family:var(--font-body,inherit)">
  <div style="font-family:var(--font-heading,inherit);font-size:22px;font-weight:700;margin-bottom:6px">Heading sample</div>
  <div style="opacity:.8;margin-bottom:14px">Body text in this theme, set at a comfortable reading size.</div>
  <button style="background:${cssValue(accent)};color:${cssValue(bg)};border:0;padding:8px 16px;border-radius:var(--radius,8px);font:inherit">Primary action</button>
</div>`
}

/** One self-contained page of live cards; a pick posts to the bridge when it runs. */
export function designPage(set: NexusDesign, canPost: boolean): string {
  const cards = set.options
    .map((option, index) => {
      const swatches = Object.entries(option.colors ?? {})
        .map(
          ([name, value]) =>
            `<div class="sw"><span style="background:${cssValue(value)}"></span><code>${escape(name)}</code><small>${escape(value)}</small></div>`,
        )
        .join('')
      const fonts = option.fonts
        ? `<p class="fonts">${Object.entries(option.fonts)
            .map(([role, font]) => `<b>${escape(role)}</b> <span style="font-family:${cssValue(String(font))}">${escape(String(font))}</span>`)
            .join(' · ')}</p>`
        : ''
      const sample = option.html ?? defaultSample(option)

      return `<article class="card" style="${cardVars(option)}" data-id="${escape(option.id)}">
  <header><span class="n">${index + 1}</span><h2>${escape(option.name)}</h2></header>
  ${option.description ? `<p class="d">${escape(option.description)}</p>` : ''}
  <div class="sample">${sample}</div>
  <div class="sws">${swatches}</div>
  ${fonts}
  <button class="pick" data-id="${escape(option.id)}">Choose this option</button>
</article>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(set.title)} · Nexus</title>
<style>
:root{--bg:#f6f6f4;--fg:#18181b;--muted:#6b6b73;--line:#e2e2de;--card:#fff;--ok:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ededef;--muted:#9a9aa3;--line:#2a2a2e;--card:#1b1b1e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1280px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--fg)}.card.chosen{border-color:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 30%,transparent)}
header{display:flex;align-items:center;gap:10px}header h2{font-size:17px;margin:0}
.n{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--fg);color:var(--bg);font-size:13px;font-weight:700}
.d{margin:0;color:var(--muted)}.sample{border-radius:10px;overflow:hidden;border:1px solid var(--line)}
.sws{display:flex;flex-wrap:wrap;gap:8px}.sw{display:flex;align-items:center;gap:6px;font-size:12px}
.sw span{width:22px;height:22px;border-radius:6px;border:1px solid var(--line)}.sw small{color:var(--muted)}
.fonts{margin:0;font-size:13px;color:var(--muted)}
.pick{margin-top:auto;padding:10px;border-radius:9px;border:1px solid var(--fg);background:var(--fg);color:var(--bg);font:600 14px system-ui;cursor:pointer}
.pick:disabled{opacity:.5;cursor:default}
#note{margin-top:22px;color:var(--muted)}
</style></head>
<body><main>
<h1>${escape(set.title)}</h1>
<p class="sub">${escape(set.kind)} · ${set.options.length} options · ${canPost ? 'choose one and it goes straight back to Claude Code' : 'pick the number in the terminal pane to send it to Claude Code'}</p>
<div class="grid">${cards}</div>
<p id="note"></p>
</main>
<script>
const canPost=${canPost ? 'true' : 'false'};
const note=document.getElementById('note');
document.querySelectorAll('.pick').forEach(btn=>btn.addEventListener('click',async()=>{
  const id=btn.dataset.id;
  document.querySelectorAll('.card').forEach(c=>c.classList.toggle('chosen',c.dataset.id===id));
  if(!canPost){note.textContent='Selection marked here. Press its number in the terminal pane to send it.';return}
  document.querySelectorAll('.pick').forEach(b=>b.disabled=true);
  try{
    const r=await fetch('/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({set:${JSON.stringify(set.id)},option:id})});
    note.textContent=r.ok?'Sent to Claude Code. You can close this tab.':'Could not send: '+r.status;
  }catch(e){note.textContent='Could not reach Claude Code: '+e}
}));
</script>
</body></html>`
}

export function comparePage(title: string, before: string, after: string, beforeAt: string, afterAt: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Before / After · Nexus</title>
<style>
:root{--bg:#f6f6f4;--fg:#18181b;--muted:#6b6b73;--line:#e2e2de}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ededef;--muted:#9a9aa3;--line:#2a2a2e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1500px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}
.stage{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;user-select:none}
.stage img{display:block;width:100%}.top{position:absolute;inset:0;overflow:hidden;width:50%;border-right:2px solid #e11d48}
.top img{width:auto;height:100%;max-width:none}
input[type=range]{width:100%;margin:14px 0}
.tag{position:absolute;top:8px;padding:2px 8px;border-radius:6px;background:#000a;color:#fff;font-size:12px}
.side{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.side img{width:100%;border:1px solid var(--line);border-radius:8px}
</style></head><body><main>
<h1>${escape(title)}</h1><p>Before ${escape(beforeAt)} · After ${escape(afterAt)} · drag the slider</p>
<div class="stage" id="stage"><img src="${escape(after)}" alt="after" id="after"><div class="top" id="top"><img src="${escape(before)}" alt="before" id="before"></div>
<span class="tag" style="left:8px">before</span><span class="tag" style="right:8px">after</span></div>
<input type="range" min="0" max="100" value="50" id="r">
<div class="side"><figure><img src="${escape(before)}" alt="before"><figcaption>Before</figcaption></figure><figure><img src="${escape(after)}" alt="after"><figcaption>After</figcaption></figure></div>
</main><script>
const r=document.getElementById('r'),top=document.getElementById('top'),b=document.getElementById('before'),s=document.getElementById('stage');
const fit=()=>{b.style.width=s.clientWidth+'px'};addEventListener('resize',fit);document.getElementById('after').addEventListener('load',fit);fit();
r.addEventListener('input',()=>{top.style.width=r.value+'%'});
</script></body></html>`
}
