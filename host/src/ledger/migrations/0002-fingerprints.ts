// 今の版・今の組に対する指紋（docs/implementation.md 4.6 (1)・(4)）。承認系の操作が添える指紋と比べる
export default `
ALTER TABLE cases ADD COLUMN set_fingerprint TEXT;
ALTER TABLE cases ADD COLUMN outline_fingerprint TEXT;
ALTER TABLE cases ADD COLUMN version_fingerprint TEXT;
ALTER TABLE cases ADD COLUMN output_fingerprint TEXT;
`
