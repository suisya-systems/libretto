// 画面を閉じていても届く通知の登録（docs/implementation.md 6.8 (6)）。端末（sessions の id）に 1 つ。
// endpoint も 1 つの端末にだけ結ぶ（ペアリングし直した同じブラウザの登録が、前の端末に残らない）
import { JST } from './0001-initial.ts'

export default `
CREATE TABLE push_subscriptions (
  session_id TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  at         TEXT NOT NULL ${JST('at')}
);
`
