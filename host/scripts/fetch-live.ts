// 本物の取り寄せの確かめ（docs/implementation.md 6.3.1 (5)）。網に出る。何も書かず、モデルを呼ばない
//   npm run verify:fetch -- <URL> [主張]
// 1 行目に結果（ok / 失敗の理由）、次に題・段落の数・指紋、主張があれば抜粋と 2-gram の含有率を出す
import { fetchSource } from '../src/facts/fetch.ts'
import { containment, excerptOf } from '../src/facts/inventory.ts'

const [url, claim] = process.argv.slice(2)
if (!url || url === '--help' || url === '-h') {
  console.log('usage: npm run verify:fetch -- <url> [claim]')
  console.log('  fetches the url with the same guards as the host (no local network, 10s, 2MB)')
  process.exit(url ? 0 : 2)
}

const r = await fetchSource(url)
if (!r.ok) {
  console.log(`fail ${r.why}`)
  process.exit(1)
}
console.log('ok')
console.log(`title: ${r.title}`)
console.log(`url: ${r.url}`)
console.log(`paragraphs: ${r.paragraphs.length}`)
console.log(`fingerprint: ${r.fingerprint}`)
if (claim) {
  const scored = r.paragraphs.map((p) => ({ p, score: containment(claim, p) })).sort((a, b) => b.score - a.score)
  const top = scored[0]
  console.log(`best score: ${top ? top.score.toFixed(2) : 'none'} (needs 0.30)`)
  if (top) console.log(`excerpt: ${excerptOf(claim, top.p)}`)
} else {
  for (const p of r.paragraphs.slice(0, 5)) console.log(`- ${p.slice(0, 120)}`)
}
