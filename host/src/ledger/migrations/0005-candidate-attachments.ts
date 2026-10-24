// 候補カードに添付の名前の全部と、取り込んだアカウント（docs/implementation.md 6.4 (4)(5)）。行ごと消せる表なので、見送れば消える
export default `
ALTER TABLE candidate_cards ADD COLUMN attachments TEXT;
ALTER TABLE candidate_cards ADD COLUMN account TEXT;
`
