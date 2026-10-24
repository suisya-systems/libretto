// 直訳調マーカーの検出（docs/implementation.md 6.3・6.2.1 (5)）。話し相手の自前点検と、自然さの機械判定（Issue 11）に共用
// 表は少なく保つ（当たりすぎると言い直しで費用が倍になる）
const MARKERS: readonly [string, RegExp][] = [
  ['することができ', /することができ/g],
  ['において', /において/g],
  ['に関して', /に関して/g],
  ['を行う', /を行(?:う|い|っ|わ|え|お)/g],
  ['であろう', /であろう/g],
  ['を可能に', /を可能に/g],
  ['の観点から', /の観点から/g],
  ['いくつかの', /いくつかの/g],
  ['を持っている', /を持って(?:い|お)/g],
  ['彼は', /彼は/g],
  ['彼女は', /彼女は/g],
  ['行末のコロン', /[:：][ \t]*$/gm],
]

export function markerCheck(text: string): { hits: { marker: string; where: number }[] } {
  const hits = MARKERS.flatMap(([marker, re]) => [...text.matchAll(re)].map((m) => ({ marker, where: m.index })))
  return { hits: hits.sort((a, b) => a.where - b.where) }
}
