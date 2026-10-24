// 仕立て（docs/implementation.md 6.2.8 (1)(2)(4)）。ページはブロックだけで組み直し、貼り付け用は字だけ
import { describe, expect, it } from 'vitest'
import { runCode } from '../src/checks/judgeable.ts'
import { renderHtml } from '../src/checks/text.ts'
import { pageBlocks, pageDocument } from '../src/deliver/page.ts'
import { pasteText } from '../src/deliver/paste.ts'
import { attachment } from '../src/server/app.ts'

const MD = '# 題\n\n前置きの **強調** です。\n\n## 見出し\n\n- 一つ目\n- 二つ目\n\n1. 手順\n2. 次\n'
const at = '2026-10-23T16:30:00.000Z' // 東京では 10/24
const doc = (html: string) => pageDocument(html, { title: '題 <x>', n: 2, at })
const check = (fn: 'pageRoundTrip' | 'pasteSafe', input: { md: string; page?: string; paste?: string }) =>
  runCode({ id: 'C90', judge: { by: 'code', fn, args: {} }, pass: { kind: 'all' } } as never, input)

describe('ページ（6.2.8 (1)）', () => {
  it('ブロックの外の字・div・blockquote の直下の字・script は出さず、ブロックの中の字と強調は残す', () => {
    const html = `<!doctype html><html><head><title>t</title><style>p{}</style></head><body>
      裸の字<div>div の字<p class="x" onclick="a()">段落の <b>太字</b> と <a href="javascript:1">リンク</a> &amp; 記号</p></div>
      <blockquote>引用の直下<p>引用の段落</p></blockquote><script>alert(1)</script>
      <h5>小見出し</h5><p></p><ol><li>一<ul><li>入れ子</li></ul></li><li>二</li></ol><li>外の項目</li></body></html>`
    expect(pageBlocks(html)).toEqual([
      { kind: 'p', html: '段落の <strong>太字</strong> と リンク &amp; 記号' },
      { kind: 'p', html: '引用の段落' },
      { kind: 'h3', html: '小見出し' },
      { kind: 'li', list: 'ol', html: '一入れ子' },
      { kind: 'li', list: 'ol', html: '二' },
      { kind: 'li', list: 'ul', html: '外の項目' },
    ])
    const page = doc(html)
    for (const s of ['裸の字', 'div の字', '引用の直下', 'alert', 'onclick', 'javascript'])
      expect(page).not.toContain(s)
    expect(page).toContain('<title>題 &lt;x&gt;</title>')
  })

  it('本文から組み立てた HTML は pageRoundTrip を通り、枠（題・日付）はブロックに数えない', async () => {
    const page = doc(renderHtml(MD))
    expect(page).toContain('バージョン 2')
    expect(page).toContain('2026/10/24')
    expect((await check('pageRoundTrip', { md: MD, page })).units).toEqual([true])
    // ブロックが欠けていれば落ちる
    const short = doc('<h1>題</h1>')
    expect((await check('pageRoundTrip', { md: MD, page: short })).units).toEqual([false])
  })

  it('同じ入力からは同じバイト列（再起動で流し直しても指紋が変わらない）', () => {
    expect(doc(renderHtml(MD))).toBe(doc(renderHtml(MD)))
  })
})

describe('貼り付け用（6.2.8 (1)(2)）', () => {
  it('字だけにして pasteSafe を通る。箇条書きは「・」と番号', async () => {
    const t = pasteText(MD)
    expect(t).toBe('題\n\n前置きの 強調 です。\n\n見出し\n\n・一つ目\n・二つ目\n\n1. 手順\n2. 次\n')
    expect((await check('pasteSafe', { md: MD, paste: t })).units).toEqual([true])
  })

  it('表は外側の | があってもなくても落とす', async () => {
    for (const table of ['| A | B |\n| --- | --- |\n| 1 | 2 |', 'A | B\n--- | ---\n1 | 2', 'A | B\n:-- | --:\n1 | 2']) {
      const paste = pasteText(`段落\n\n${table}\n`)
      expect((await check('pasteSafe', { md: '', paste })).units).toEqual([false])
    }
  })
})

describe('ダウンロードの名前（6.2.8 (4)）', () => {
  it('ASCII の名前と、題を百分率符号化した名前。制御文字と / \\ は _', () => {
    expect(attachment("ブレスト's (まとめ)*", 3)).toBe(
      'attachment; filename="page-v3.html"; filename*=UTF-8\'\'%E3%83%96%E3%83%AC%E3%82%B9%E3%83%88%27s%20%28%E3%81%BE%E3%81%A8%E3%82%81%29%2A-%E7%AC%AC3%E7%89%88.html',
    )
    expect(decodeURIComponent(attachment('a/b\\c\nd', 1).split("''")[1] as string)).toBe('a_b_c_d-第1版.html')
  })
})
