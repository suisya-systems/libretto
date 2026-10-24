// ホストに見立てたプロセス（8.9 (6) のテストと実機の確認）。偽の CLI を作り手として起こしたまま待つ。テストがこれを SIGKILL する
// 4 つ目の引数（LIBRETTO_HOME）があれば本物の srt で包む。5 つ目は ripgrep として起こす claude の実体
import { randomUUID } from 'node:crypto'
import { createClaudeCli } from '../../src/model/claude-cli.ts'
import { createSandbox } from '../../src/model/sandbox.ts'

const [fake = '', dir = '', control = '', home, rg] = process.argv.slice(2)
const command = [process.execPath, fake]
const backend = createClaudeCli({
  usdJpy: () => 150,
  callsDir: dir,
  command,
  ...(home && {
    sandbox: createSandbox({
      home,
      claude: command,
      check: () => ({ isolation: 'strong', claudeOk: true }),
      ...(rg && { rg }),
    }),
  }),
  log: () => {},
})
await backend({
  callId: randomUUID(),
  role: '作り手',
  caseId: 'c1',
  instruction: control,
  materials: [],
  access: 'write',
  workdir: dir,
  family: 'claude',
  model: 'claude-opus-5-5',
  maxYen: 150,
  signal: new AbortController().signal,
})
