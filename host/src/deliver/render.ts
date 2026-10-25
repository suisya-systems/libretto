// 描き出しと計算し直し（docs/implementation.md 6.10 (3)(5)）。LibreOffice（soffice）で PDF・xlsx に、poppler（pdftoppm）でページの画像に。
// 道具が無い・失敗した・時間切れは ToolFailure（判定役が fail.system(道具の失敗) で止める。10 章）
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export class ToolFailure extends Error {}

// 事前点検で見つけた道具の名前（無ければ undefined）。起動時に 1 回（6.10 (5)）
export type Tools = { soffice?: string; pdftoppm?: string }
const CALL_MS = 120_000

function run(cmd: string | undefined, args: string[], signal: AbortSignal): Promise<void> {
  if (!cmd) return Promise.reject(new ToolFailure('tool not installed'))
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]) }, (e) => {
      if (!e) return resolve()
      if (signal.aborted) return reject(signal.reason)
      reject(new ToolFailure(`${cmd}: ${e.message}`))
    }),
  )
}

// 起動時の事前点検。--version が通れば入っている
export async function preflight(names: { soffice: string; pdftoppm: string }): Promise<Tools> {
  const ok = (cmd: string, flag: string) =>
    run(cmd, [flag], new AbortController().signal).then(
      () => cmd,
      () => undefined,
    )
  const [soffice, pdftoppm] = await Promise.all([ok(names.soffice, '--version'), ok(names.pdftoppm, '-v')])
  return { ...(soffice && { soffice }), ...(pdftoppm && { pdftoppm }) }
}

export type Page = { png: string; blank: boolean }
// 白（250 以上）でない画素がこの割合より少ないページは空白
const INK = 0.001
export const MAX_PAGES = 40 // 見た目の判定に渡すページの上限（超えたら判定できない。6.10 (3)）

// PGM（P5、8 bit）の画素から空白かを決める
export function blankPgm(buf: Buffer): boolean {
  const head = /^P5\s+(?:#[^\n]*\s+)*(\d+)\s+(?:#[^\n]*\s+)*(\d+)\s+(?:#[^\n]*\s+)*(\d+)\s/.exec(
    buf.toString('latin1', 0, 200),
  )
  if (!head) throw new ToolFailure('pdftoppm: not a PGM')
  const [w, h, max] = [Number(head[1]), Number(head[2]), Number(head[3])]
  const px = buf.subarray(head[0].length, head[0].length + w * h)
  let ink = 0
  for (const v of px) if ((v * 255) / max < 250) ink++
  return ink < w * h * INK
}

const numbered = (dir: string, prefix: string, ext: string) =>
  readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(ext))
    .sort((a, b) => Number(/-(\d+)\./.exec(a)?.[1]) - Number(/-(\d+)\./.exec(b)?.[1]))
    .map((f) => join(dir, f))

// 呼び出しごとに作る。同じ中身は 1 回だけ描き出す。root は案件フォルダの render/（判定役・画像の作業場）
export function renderer(tools: Tools, root: string, signal: AbortSignal) {
  const memo = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, f: () => Promise<T>) => {
    if (!memo.has(key)) memo.set(key, f())
    return memo.get(key) as Promise<T>
  }
  const fresh = (name: string) => {
    const dir = join(root, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }
  const soffice = (dir: string, to: string, file: string) =>
    run(
      tools.soffice,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`,
        '--convert-to',
        to,
        '--outdir',
        join(dir, 'out'),
        file,
      ],
      signal,
    )
  return {
    root,
    pages: (buf: Buffer, ext: 'pptx' | 'docx') =>
      once(`pages:${ext}:${sha256(buf)}`, async (): Promise<Page[]> => {
        if (!tools.soffice || !tools.pdftoppm) throw new ToolFailure('tool not installed')
        const dir = fresh(`${ext}-${sha256(buf).slice(0, 16)}`)
        const file = join(dir, `in.${ext}`)
        writeFileSync(file, buf)
        await soffice(dir, 'pdf', file)
        const pdf = join(dir, 'out', 'in.pdf')
        await run(tools.pdftoppm, ['-gray', '-r', '24', pdf, join(dir, 'g')], signal)
        await run(tools.pdftoppm, ['-png', '-r', '80', pdf, join(dir, 'p')], signal)
        const gray = numbered(dir, 'g', '.pgm')
        const png = numbered(dir, 'p', '.png')
        if (!gray.length || gray.length !== png.length) throw new ToolFailure('pdftoppm: pages do not match')
        return png.map((p, i) => ({ png: p, blank: blankPgm(readFileSync(gray[i] as string)) }))
      }),
    // 式を計算し直した xlsx（6.10 (3)）
    recalc: (buf: Buffer) =>
      once(`recalc:${sha256(buf)}`, async (): Promise<Buffer> => {
        const dir = fresh(`xlsx-${sha256(buf).slice(0, 16)}`)
        const file = join(dir, 'in.xlsx')
        writeFileSync(file, buf)
        await soffice(dir, 'xlsx', file)
        try {
          return readFileSync(join(dir, 'out', 'in.xlsx'))
        } catch {
          throw new ToolFailure('soffice: no output')
        }
      }),
  }
}
export type Renderer = ReturnType<typeof renderer>
