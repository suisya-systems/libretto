// 通知を止める時間帯に出さなかったお知らせの印（docs/implementation.md 6.8 (14)）。明けの 1 通はこの印の行を数える
export default `
ALTER TABLE notices ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
`
