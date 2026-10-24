// 再起動の精算の記録（docs/implementation.md 9.4 (7)）。charge と同じトランザクションで書く
import { appendOnly, JST } from './0001-initial.ts'

export default `
CREATE TABLE cost_recoveries (
  call_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  source  TEXT NOT NULL CHECK (source IN ('結果', '予約')),
  at      TEXT NOT NULL ${JST('at')}
);
CREATE INDEX cost_recoveries_by_case ON cost_recoveries(case_id, source);
${appendOnly('cost_recoveries')}
`
