// 候補カードに他人の投稿かどうか（docs/implementation.md 6.6 (5)）。Slack の合図のカードだけが書く
export default `
ALTER TABLE candidate_cards ADD COLUMN others_post INTEGER;
`
