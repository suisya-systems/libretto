// 読んだ会議メモ（docs/implementation.md 6.7 (2)(3)）。ファイルの版（modified_time）ごとに読み直すかを決め、
// 「行動項目なし」と「見つけられません」を出す。本文は持たない
export default `
CREATE TABLE meet_notes (
  account       TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  held_at       TEXT NOT NULL,
  link          TEXT NOT NULL,
  modified_time TEXT NOT NULL,
  result        TEXT NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  read_at       TEXT NOT NULL,
  PRIMARY KEY (account, file_id)
);
`
