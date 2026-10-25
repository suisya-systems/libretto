// お知らせを書く口と送り出し（docs/implementation.md 6.8 (5)）。event_id で同じ遷移の 2 行目を弾き、
// 画面の外へ出すものは notice_deliveries に pending で残して送り出しの仕事が送る。revision は確認待ちの送る前の確かめ直しに使う
import { JST } from './0001-initial.ts'

export default `
ALTER TABLE notices ADD COLUMN event_id TEXT;
ALTER TABLE notices ADD COLUMN path TEXT NOT NULL DEFAULT '/';
ALTER TABLE notices ADD COLUMN outside INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notices ADD COLUMN revision INTEGER;
CREATE UNIQUE INDEX notices_by_event ON notices(event_id);

CREATE TABLE notice_deliveries (
  notice_seq INTEGER NOT NULL REFERENCES notices(seq),
  target     TEXT NOT NULL,
  status     TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  next_at    TEXT NOT NULL ${JST('next_at')},
  PRIMARY KEY (notice_seq, target)
);
CREATE INDEX notice_deliveries_pending ON notice_deliveries(next_at) WHERE status = 'pending';
`
