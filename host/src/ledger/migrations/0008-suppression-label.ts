// 除外した差出人・チャンネル・会議の、画面に出す名前（docs/implementation.md 6.9 (7)）
export default `
ALTER TABLE suppressions ADD COLUMN label TEXT;
`
