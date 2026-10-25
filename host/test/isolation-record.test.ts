// 隔離の確認の記録（docs/implementation.md 8.10 (7)）。ファイル名・表の行・行の差し替え
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { listedNames, putRow, recordName, tableRow } from '../scripts/isolation-record.ts'

const run = (rows: [string, boolean, string][]) => ({
  platform: 'darwin',
  day: '2026-10-27',
  node: 'v22.17.0',
  claude: '2.1.310',
  isolation: 'strong',
  verdict: 'hidden',
  rows,
})

describe('isolation record', () => {
  it('names the macOS file macos, not darwin', () => {
    expect(recordName('darwin', '2026-10-27')).toBe('isolation-macos-2026-10-27.md')
    expect(recordName('linux', '2026-10-24')).toBe('isolation-linux-2026-10-24.md')
  })

  it('treats a refused or missing listing as showing nothing', () => {
    expect(listedNames('ls: /Users/a: Operation not permitted')).toEqual([])
    expect(listedNames("ls: cannot open directory '/home/a': Permission denied")).toEqual([])
    expect(listedNames('ls: /Users/a/.claude: No such file or directory')).toEqual([])
    expect(listedNames(' .claude .local work ')).toEqual(['.claude', '.local', 'work'])
  })

  it('writes PASS or the failed rows into the table row', () => {
    expect(
      tableRow(
        run([
          ['a', true, ''],
          ['b', true, ''],
        ]),
      ),
    ).toBe(
      '| macOS（Node 22.17.0・claude 2.1.310） | 2026-10-27 | 2/2 PASS（隔離の水準 strong、点検 hidden） | [isolation-macos-2026-10-27.md](./isolation-macos-2026-10-27.md) |',
    )
    expect(
      tableRow(
        run([
          ['a', true, ''],
          ['b', false, ''],
          ['c', false, ''],
        ]),
      ),
    ).toContain('| 1/3（FAIL: b, c。隔離の水準 strong、点検 hidden） |')
  })

  it('replaces only the macOS row of the real table', () => {
    const doc = readFileSync(new URL('../../docs/verification/isolation.md', import.meta.url), 'utf-8')
    const row = tableRow(run([['a', true, '']]))
    const next = putRow(doc, 'darwin', row) ?? ''
    expect(next.split('\n')).toContain(row)
    expect(next.split('\n').filter((l) => !doc.split('\n').includes(l))).toEqual([row])
    expect(next).toContain('| Linux / WSL2')
    expect(putRow(doc, 'win32', row)).toBeUndefined()
  })
})
