// 撮影用のプレビュー: states.ts の 1 状態を、fake の台本で動くホストに作って出す（Claude の答えだけ台本、ほかは本物）
// node --experimental-strip-types --no-warnings preview.ts <state> <port>
// /state は状態名（着かなければ出さずに終わる）、/frame?w=&h=&id= は撮る枠（iframe）、/shot はペアリングして状態の画面へ
// TMPDIR が無くても動く（os.tmpdir() は無ければ /tmp）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { CaseView } from '@libretto/shared/api'
import { writeIsolation } from '../../../host/src/checks/isolation.ts'
import { initHome } from '../../../host/src/ledger/db.ts'
import { createFake, type ScriptEntry } from '../../../host/src/model/fake.ts'
import { createInvoke } from '../../../host/src/model/invoke.ts'
import { setKey } from '../../../host/src/model/keys.ts'
import { createServer } from '../../../host/src/server/app.ts'
import { W } from '../../../page/src/wording.ts'
import { type Ctx, SHOOT_KEY, STATES } from './states.ts'

const [name = '', port = ''] = process.argv.slice(2)
if (name === '--list') {
  console.log(Object.keys(STATES).join('\n'))
  process.exit(0)
}
if (name === '--same-first-390') {
  console.log(
    Object.entries(STATES)
      .filter(([, s]) => s.sameFirst390)
      .map(([k]) => k)
      .join('\n'),
  )
  process.exit(0)
}
const def = STATES[name]
if (!def || !port) {
  console.error(`usage: preview.ts <${Object.keys(STATES).join('|')}> <port>`)
  process.exit(2)
}

const counts = new Map<string, number>()
const script: ScriptEntry[] = def.script.map(([role, reply]) => {
  const nth = (counts.get(role) ?? 0) + 1
  counts.set(role, nth)
  return { role, nth, reply }
})

const home = mkdtempSync(join(tmpdir(), `libretto-shoot-${name}-`))
const ledger = initHome(home)
if (def.openaiKey) setKey(home, 'openai', SHOOT_KEY)
const fake = createFake(script)
const invoke = createInvoke({
  ledger,
  backends: { claude: fake.backend, openai: fake.backend },
  caps: () => ({ caseCapYen: 1500, monthCapYen: null }),
  onCostCap: () => {},
  log: () => {},
})
const origin = `http://127.0.0.1:${port}`
const server = createServer({
  home,
  ledger,
  invoke,
  origins: [origin],
  staticDir: fileURLToPath(new URL('../../../page/dist', import.meta.url)),
  log: (l) => console.error(l),
  ...(def.isolation && { isolation: def.isolation.level }),
  ...(def.isolation?.cause && { cause: def.isolation.cause }),
})
if (def.isolation?.last) writeIsolation(home, def.isolation.last)
let http: ReturnType<typeof serve> | undefined
const shutdown = async (code: number) => {
  await server.runs.abortAll()
  http?.close()
  ledger.close()
  rmSync(home, { recursive: true, force: true })
  process.exit(code)
}
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

const pairCookie = async () => {
  const p = await server.app.fetch(new Request(`${origin}${new URL(server.issuePairing('shoot').url).pathname}`))
  return (p.headers.get('set-cookie') ?? '').split(';')[0] as string
}
const cookie = await pairCookie()
const api = (path: string, body?: unknown) =>
  server.app.fetch(
    new Request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  )

// 会話で依頼を 1 つ出し、入口待ち（本人の番）まで進める。ここから先は状態ごと
server.conversation.post({
  requestId: crypto.randomUUID(),
  lastSeq: 0,
  text: '先週の社内ブレストを note 記事にまとめて',
})
await server.conversation.settled()
const caseId = ledger.lastMessage('lobby')?.caseId
if (!caseId) {
  console.error('no case from the conversation')
  await shutdown(1)
}
const view = async () => CaseView.parse(await (await api(`/api/cases/${caseId}`)).json())
const ctx: Ctx = {
  caseId: caseId as string,
  view,
  act: async (a) => {
    const v = await view()
    const r = await api(`/api/cases/${caseId}/actions`, {
      ...a,
      eventId: crypto.randomUUID(),
      expectedRevision: v.revision,
    })
    if (!r.ok) throw new Error(`${a.type}: ${r.status} ${await r.text()}`)
  },
  until: async (ok) => {
    let v = await view()
    for (let i = 0; i < 400 && !ok(v); i++) {
      await new Promise((res) => setTimeout(res, 25))
      v = await view()
    }
    if (!ok(v)) throw new Error(`stuck at ${v.state}/${v.turn} (${v.step}) stop=${v.stopReason ?? '-'}`)
    return v
  },
}
try {
  await ctx.until((v) => v.state === '入口待ち' && v.turn === '本人' && !!v.entrance)
  await def.drive?.(ctx)
  const v = await view()
  if (!def.expect(v))
    throw new Error(`not ${name}: ${v.state}/${v.turn} v=${v.version} review=${JSON.stringify(v.review)}`)
} catch (e) {
  console.error(`preview ${name} failed: ${e instanceof Error ? e.message : String(e)}`)
  await shutdown(1)
}

// 撮る枠。iframe の中に mark（と selector）が出て、読み込み中・失敗の表示が無くなったら /ready を呼ぶ。
// それまで /hold の画像を返さず、ページの load（= Chrome が撮る時）を止める。動きは止めて撮る
const FAILED = [W['load.offline'], W['load.failed'], W['pair.title'], W['case.notFound'], W['notFound.title']]
const frame = (fw: number, fh: number, id: string) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#888}iframe{border:0;display:block}</style>
<iframe id="f" src="/shot" width="${fw}" height="${fh}"></iframe>
<script>
const mark = ${JSON.stringify(def.mark)}, selector = ${JSON.stringify(def.selector ?? '')}, failed = ${JSON.stringify(FAILED)}
const t = setInterval(() => {
  const d = document.getElementById('f').contentDocument
  if (!d || !d.body) return
  if (!d.getElementById('shoot-still')) {
    const s = d.createElement('style')
    s.id = 'shoot-still'
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
    d.head.append(s)
  }
  const text = d.body.textContent
  if (!text.includes(mark) || d.querySelector('[aria-busy="true"]')) return
  if (selector && !d.querySelector(selector)) return
  if (failed.some((f) => text.includes(f))) return
  clearInterval(t)
  setTimeout(() => {
    const h = d.documentElement.scrollHeight
    const dark = matchMedia('(prefers-color-scheme: dark)').matches ? 1 : 0
    fetch('/ready?id=${id}&h=' + h + '&dark=' + dark)
  }, 700)
}, 100)
</script>
<img src="/hold?id=${id}" alt="" width="1" height="1" style="position:absolute;left:-9px">`

const gif = () =>
  new Response(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'), {
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' },
  })
const holds = new Map<string, () => void>()
http = serve({
  port: Number(port),
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const u = new URL(req.url)
    const id = u.searchParams.get('id') ?? ''
    if (u.pathname === '/state') return new Response(name)
    if (u.pathname === '/shot') {
      return new Response(null, {
        status: 302,
        headers: { location: def.path?.(ctx.caseId) ?? `/cases/${ctx.caseId}`, 'set-cookie': await pairCookie() },
      })
    }
    if (u.pathname === '/frame') {
      const html = frame(Number(u.searchParams.get('w') ?? 390), Number(u.searchParams.get('h') ?? 844), id)
      return new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
    }
    // 1 枚ごとの id で READY / TIMEOUT を出す。shoot.sh は自分の id の行だけを見る
    if (u.pathname === '/ready') {
      const go = holds.get(id)
      if (go) {
        holds.delete(id)
        console.log(`READY ${id} h=${u.searchParams.get('h')} dark=${u.searchParams.get('dark')}`)
        go()
      }
      return new Response('ok')
    }
    if (u.pathname === '/hold')
      return new Promise<Response>((resolve) => {
        holds.set(id, () => resolve(gif()))
        setTimeout(() => {
          if (!holds.delete(id)) return
          console.log(`TIMEOUT ${id}`)
          resolve(gif())
        }, 15_000)
      })
    return server.app.fetch(req)
  },
})
const c = ledger.getCase(ctx.caseId)
console.log(
  `preview ${name} ${origin} state=${c?.state} turn=${c?.turn} v=${c?.version} unused=${fake.unused().length}`,
)
