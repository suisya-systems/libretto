// 隔離の確認の記録（docs/implementation.md 8.10 (7)）。sandbox-live.ts --record が書くファイルの名前と、
// docs/verification/isolation.md の記録の表の行。流した人が手で表を直さずに済むよう、その OS の行を差し替える

// ファイル名と表の見出し。darwin は人が読む名前にする
const OS: Record<string, { slug: string; label: string }> = {
  darwin: { slug: 'macos', label: 'macOS' },
  linux: { slug: 'linux', label: 'Linux / WSL2' },
}
export const osSlug = (platform: string) => OS[platform]?.slug ?? platform
export const osLabel = (platform: string) => OS[platform]?.label ?? platform

export const recordName = (platform: string, day: string) => `isolation-${osSlug(platform)}-${day}.md`

// ls がホームを開けなかった（Seatbelt は拒否したディレクトリの一覧を Operation not permitted で返す）・無いときは、何も見えていない
export const listedNames = (value: string) =>
  /: (Operation not permitted|Permission denied|No such file or directory)/.test(value)
    ? []
    : value.trim().split(/\s+/).filter(Boolean)

export type Run = {
  platform: string
  day: string
  node: string
  claude: string
  isolation: string
  verdict?: string | undefined // 点検の判定（--probe のときだけ）
  rows: [string, boolean, string][]
}

export function tableRow(r: Run): string {
  const failed = r.rows.filter(([, ok]) => !ok).map(([name]) => name)
  const passed = r.rows.length - failed.length
  const detail = [`隔離の水準 ${r.isolation}`, ...(r.verdict ? [`点検 ${r.verdict}`] : [])].join('、')
  const result = failed.length
    ? `${passed}/${r.rows.length}（FAIL: ${failed.join(', ')}。${detail}）`
    : `${passed}/${r.rows.length} PASS（${detail}）`
  const name = recordName(r.platform, r.day)
  return `| ${osLabel(r.platform)}（Node ${r.node.replace(/^v/, '')}・claude ${r.claude}） | ${r.day} | ${result.replaceAll('|', '\\|')} | [${name}](./${name}) |`
}

// 記録の表でその OS の行（見出しで始まる行）を差し替える。行が無ければ undefined（手で足す）
export function putRow(doc: string, platform: string, row: string): string | undefined {
  const lines = doc.split('\n')
  const i = lines.findIndex((l) => l.startsWith(`| ${osLabel(platform)}`))
  if (i < 0) return undefined
  lines[i] = row
  return lines.join('\n')
}
