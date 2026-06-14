import { chromium } from '@playwright/test'
const b = await chromium.launch({ headless: false })
const p = await b.newPage({ viewport: { width: 1100, height: 1400 } })
await p.addInitScript(() => localStorage.setItem('inkwave:gappedPages', '1'))
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p.waitForSelector('.ProseMirror', { timeout: 15000 })
await p.click('.ProseMirror')
const para = 'Seahorses are a genus of small marine fish in the family Syngnathidae and they swim upright. '
for (let i = 0; i < 26; i++) await p.keyboard.insertText(para)
await p.waitForTimeout(1000)
await p.evaluate(()=>window.scrollTo(0,0))
const tgt = await p.evaluate(()=>{ const gap=document.querySelector('.inkwave-page-gap').getBoundingClientRect(); let best=null
  for (const el of document.querySelectorAll('.ProseMirror > p')){ const r2=document.createRange(); r2.selectNodeContents(el)
    for (const r of r2.getClientRects()){ if(r.width>1&&r.height>5&&r.height<80&&r.bottom<=gap.top+2){ if(!best||r.bottom>best.bottom) best={x:r.left+30,y:r.top+r.height/2} } } } return best })
await p.mouse.click(tgt.x, tgt.y)
await p.keyboard.insertText('@@MARK@@')
await p.waitForTimeout(400)
const res = await p.evaluate(()=>{ const pm=document.querySelector('.ProseMirror'); const w=document.createTreeWalker(pm,NodeFilter.SHOW_TEXT); const nodes=[]; let n; let full=''
  while((n=w.nextNode())){ nodes.push({node:n,start:full.length}); full+=n.textContent }
  const idx=full.indexOf('@@MARK@@'); if(idx<0) return {notfound:true}
  let t=null,off=0; for(const e of nodes){ if(idx>=e.start&&idx<e.start+e.node.textContent.length){t=e.node;off=idx-e.start;break} }
  const r=document.createRange(); r.setStart(t,off); r.setEnd(t,Math.min(t.textContent.length,off+1)); const rect=r.getBoundingClientRect()
  const band=document.querySelector('.inkwave-page-gap-band').getBoundingClientRect()
  return {markTop:Math.round(rect.top), bandTop:Math.round(band.top), onPage1: rect.top<band.top} })
console.log('RESULT', JSON.stringify(res))
await b.close()
