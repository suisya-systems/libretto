// 起動（docs/implementation.md 12 章）。`libretto` でホスト、`libretto stop` で緊急停止（4.4・5.7 (3)）
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { transition } from './case/transition.ts'
import { causeOf, checkIsolation, probeDir } from './checks/isolation.ts'
import { purgeClosed } from './facts/purge.ts'
import { callsDir, caseDir, initHome, monthCapFromEnv, resolveHome } from './ledger/db.ts'
import { createClaudeCli, resolveClaude } from './model/claude-cli.ts'
import { createInvoke, type Job } from './model/invoke.ts'
import { createJev } from './model/jev.ts'
import { readKey } from './model/keys.ts'
import { JEV_DAILY_LIMIT } from './model/noul.ts'
import { createOpenai } from './model/openai.ts'
import { settleOrphans } from './model/orphans.ts'
import { checkSandbox, createSandbox, MIN_CLAUDE, type Sandbox } from './model/sandbox.ts'
import { createServer } from './server/app.ts'
import { writeStopFile } from './server/stop.ts'

const home = resolveHome()
const monthCapYen = monthCapFromEnv()

if (process.argv[2] === 'stop') {
  writeStopFile(home)
  console.log('STOP written. The host stops everything within 2 seconds.')
  process.exit(0)
}

const port = Number(process.env.LIBRETTO_PORT ?? 7780)
const bind = process.env.LIBRETTO_BIND ?? '127.0.0.1'
const origins = (process.env.LIBRETTO_ORIGIN ?? `http://127.0.0.1:${port}`).split(',').map((s) => s.trim())

const ledger = initHome(home)
// 途中で落ちた呼び出しの精算を、STOP の確認・HTTP・runner より前に済ませる。失敗したら起動しない（9.4 (7)）
const settled = settleOrphans(ledger, callsDir(home))
if (settled.result + settled.hold)
  console.error(`libretto: settled ${settled.result} calls from results, ${settled.hold} at the reserved amount`)
// 作り手の隔離と claude の版を、runner が仕事を起こす前に確かめる（8.9 (5)）
const claude = resolveClaude()
const sandboxCheck = await checkSandbox({ home, claude })
console.error(
  `libretto: isolation ${sandboxCheck.isolation}${sandboxCheck.reason ? ` (${sandboxCheck.reason})` : ''}, claude ${sandboxCheck.claudeVersion ?? 'unknown'}`,
)
if (sandboxCheck.reason?.startsWith('missing:') || sandboxCheck.reason === 'userns')
  console.error(
    'libretto: the sandbox tools are missing. Install: apt install bubblewrap socat, and sysctl kernel.apparmor_restrict_unprivileged_userns=0',
  )
if (!sandboxCheck.claudeOk)
  console.error(`libretto: Claude Code ${MIN_CLAUDE} or later is required. Claude is not called.`)
const sandbox = createSandbox({ home, claude, check: () => sandboxCheck })
// 隔離の点検の対照: checks/ を開け直した起こし方（8.10 (4)）
const control = createSandbox({
  home,
  claude,
  check: () => sandboxCheck,
  reopen: [join(probeDir(home), 'checks')],
})
// ponytail: 為替と上限は 5.3 の既定（P3: 全体は未入力。検証では LIBRETTO_MONTH_CAP_YEN。11.3 (2)）。settings.json から読むのは設定の Issue
const usdJpy = () => 150
const invokeWith = (box: Sandbox) =>
  createInvoke({
    ledger,
    backends: {
      claude: createClaudeCli({
        usdJpy,
        callsDir: callsDir(home),
        sandbox: box,
        blocked: () =>
          sandboxCheck.claudeOk ? undefined : `claude ${sandboxCheck.claudeVersion ?? 'unknown'} < ${MIN_CLAUDE}`,
      }),
      openai: createOpenai({ key: () => readKey(home, 'openai'), usdJpy }),
      jev: createJev({ key: () => readKey(home, 'jev'), usdJpy }),
    },
    caps: () => ({ caseCapYen: 1500, monthCapYen }),
    dailyLimits: { jev: JEV_DAILY_LIMIT },
    // 費用上限で案件を止める（6.1.1 (1)）。revision は確かめない。止めたら画面に知らせる（6.2.2 (1)）
    onCostCap: (n) => {
      const r = transition(ledger, { type: 'cost.cap', by: '費用', ...n })
      if (r.ok && !r.replayed) server.caseChanged(n.caseId)
    },
    callsDir: callsDir(home),
    jobsDir: (caseId) => join(caseDir(home, caseId), 'jobs'),
    ...(process.env.LIBRETTO_DEBUG_DIR && { debugDir: process.env.LIBRETTO_DEBUG_DIR }),
  })
const invoke = invokeWith(sandbox)
const cause = causeOf(sandboxCheck.reason)
const invokeControl: (job: Job) => ReturnType<typeof invoke> = invokeWith(control)
const server = createServer({
  home,
  ledger,
  invoke,
  origins,
  staticDir: fileURLToPath(new URL('../../page/dist', import.meta.url)),
  isolation: sandboxCheck.isolation,
  ...(cause && { cause }),
  probe: (signal) =>
    checkIsolation(
      {
        home,
        check: () => sandboxCheck,
        invoke,
        control: invokeControl,
        homeNames: (work) => sandbox.homeNames(work),
      },
      signal,
    ),
})
server.stop.boot()
// 閉じた案件の資料と出典の本文を消し残していれば消す（6.3.1 (10)）。runner より前
try {
  purgeClosed(home, ledger)
} catch (e) {
  console.error(`libretto: purge not finished: ${(e as Error).message}`)
}
// libretto の番の案件の仕事を起こし直す（4.4 の再起動。6.2.3 (1)）。精算と STOP の確認の後
server.runner.resume()
// 隔離の点検を裏で 1 回（8.4・8.10 (4)）。止めていれば起動時は流さない
try {
  void server.checkIsolation()
} catch (e) {
  console.error(`libretto: isolation check not started: ${(e as Error).message}`)
}

let ticks = 0
const timer = setInterval(() => {
  ticks += 1
  server.stop.tick(ticks % 15 === 0).catch((e) => console.error(e))
}, 2_000)

const http = serve({ fetch: server.app.fetch, port, hostname: bind }, () => {
  const { url } = server.issuePairing('最初の端末', true)
  console.log(`libretto: http://${bind}:${port}`)
  console.log(`Open this URL once on the device to pair (valid 10 minutes): ${url}`)
})

// 通常の終了は遷移ではない（4.2 の末尾）。動いている仕事を止めて閉じる
const shutdown = async () => {
  clearInterval(timer)
  await server.runs.abortAll()
  http.close()
  ledger.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
