// 9.2 の表の定義（docs の DDL はこの写し）。時刻の形の CHECK と追記専用のトリガーは 9.1・9.4
export const JST = (col: string) =>
  `CHECK (${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]+09:00')`

export const appendOnly = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`

export default `
CREATE TABLE cases (
  case_id      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  state        TEXT NOT NULL,
  turn         TEXT NOT NULL,
  step         TEXT NOT NULL,
  mode         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  auto         INTEGER NOT NULL,
  doc_type     TEXT NOT NULL,
  destination  TEXT NOT NULL,
  deadline     TEXT,
  candidate_id TEXT,
  version      INTEGER NOT NULL DEFAULT 0,
  series       INTEGER NOT NULL DEFAULT 1,
  round        INTEGER NOT NULL DEFAULT 0,
  revision     INTEGER NOT NULL DEFAULT 0,
  approval_kind TEXT,
  stop_reason  TEXT,
  created_at   TEXT NOT NULL ${JST('created_at')},
  updated_at   TEXT NOT NULL ${JST('updated_at')}
);
CREATE INDEX cases_by_state ON cases(state, turn, updated_at);
CREATE INDEX cases_by_auto  ON cases(auto, created_at);

CREATE TABLE case_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  case_id    TEXT NOT NULL REFERENCES cases(case_id),
  type       TEXT NOT NULL,
  from_state TEXT, to_state TEXT, event TEXT, by TEXT, turn TEXT, step TEXT, reason TEXT,
  version    INTEGER, series INTEGER, round INTEGER,
  detail     TEXT,
  at         TEXT NOT NULL ${JST('at')}
);
CREATE INDEX case_events_by_case ON case_events(case_id, seq);
${appendOnly('case_events')}

CREATE TABLE candidates (
  candidate_id        TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  origin              TEXT NOT NULL,
  confidence          TEXT,
  ai_instruction_flag INTEGER NOT NULL,
  sender_key          TEXT NOT NULL,
  status              TEXT NOT NULL,
  case_id             TEXT,
  updated_at          TEXT NOT NULL ${JST('updated_at')}
);
CREATE INDEX candidates_by_status ON candidates(status, origin, confidence, updated_at);

CREATE TABLE candidate_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
  type         TEXT NOT NULL,
  detail       TEXT,
  at           TEXT NOT NULL ${JST('at')}
);
CREATE INDEX candidate_events_by_candidate ON candidate_events(candidate_id, seq);
${appendOnly('candidate_events')}

CREATE TABLE candidate_cards (
  candidate_id       TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
  subject            TEXT NOT NULL,
  from_name          TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  link               TEXT NOT NULL,
  reason             TEXT,
  summary            TEXT NOT NULL,
  proposal           TEXT NOT NULL,
  attachments_needed TEXT
);

CREATE TABLE suppressions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  added_at   TEXT NOT NULL ${JST('added_at')},
  removed_at TEXT ${JST('removed_at')}
);
CREATE INDEX suppressions_active ON suppressions(kind, value) WHERE removed_at IS NULL;

CREATE TABLE costs (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  call_id    TEXT,
  case_id    TEXT NOT NULL,
  role       TEXT, family TEXT, model TEXT,
  yen        REAL, hold_yen REAL,
  tokens_in  INTEGER, tokens_out INTEGER,
  item_id    TEXT,
  at         TEXT NOT NULL ${JST('at')},
  CHECK (
    (type = 'hold' AND call_id IS NOT NULL AND role IS NOT NULL AND family IS NOT NULL AND model IS NOT NULL
      AND hold_yen IS NOT NULL AND hold_yen >= 0 AND yen IS NULL AND item_id IS NULL)
    OR (type = 'charge' AND call_id IS NOT NULL AND yen IS NOT NULL AND yen >= 0 AND hold_yen IS NULL AND item_id IS NULL)
    OR (type = 'classified' AND case_id = '推測' AND item_id IS NOT NULL AND call_id IS NULL AND yen IS NULL AND hold_yen IS NULL)
  ),
  CHECK (tokens_in IS NULL OR tokens_in >= 0),
  CHECK (tokens_out IS NULL OR tokens_out >= 0)
);
CREATE UNIQUE INDEX costs_one_per_call ON costs(call_id, type) WHERE type IN ('hold', 'charge');
CREATE UNIQUE INDEX costs_one_per_item ON costs(item_id) WHERE type = 'classified';
CREATE INDEX costs_by_case ON costs(case_id, at);
CREATE INDEX costs_by_type ON costs(type, at);
CREATE TRIGGER costs_charge_needs_hold BEFORE INSERT ON costs
  WHEN NEW.type = 'charge' AND NOT EXISTS (
    SELECT 1 FROM costs WHERE type = 'hold' AND call_id = NEW.call_id AND case_id = NEW.case_id)
  BEGIN SELECT RAISE(ABORT, 'charge without hold'); END;
${appendOnly('costs')}

CREATE TABLE approvals (
  event_id            TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES cases(case_id),
  gate                TEXT NOT NULL,
  by                  TEXT NOT NULL,
  version             INTEGER,
  version_fingerprint TEXT,
  set_fingerprint     TEXT,
  plan_fingerprint    TEXT,
  marks               TEXT,
  superseded_by       TEXT,
  at                  TEXT NOT NULL ${JST('at')}
);
CREATE INDEX approvals_by_case ON approvals(case_id, gate, at);
CREATE TRIGGER approvals_no_update BEFORE UPDATE OF event_id, case_id, gate, by, version, version_fingerprint,
  set_fingerprint, plan_fingerprint, marks, at ON approvals
  BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;
CREATE TRIGGER approvals_supersede_once BEFORE UPDATE OF superseded_by ON approvals
  WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
  BEGIN SELECT RAISE(ABORT, 'approvals.superseded_by is set once'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;

CREATE TABLE deliveries (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  attempt_id  TEXT NOT NULL,
  case_id     TEXT NOT NULL REFERENCES cases(case_id),
  target      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  receipt_id  TEXT, link TEXT, share_token TEXT,
  visibility  TEXT NOT NULL,
  overwrites  INTEGER NOT NULL,
  detail      TEXT,
  at          TEXT NOT NULL ${JST('at')}
);
CREATE INDEX deliveries_by_case    ON deliveries(case_id, attempt_id, seq);
CREATE INDEX deliveries_by_attempt ON deliveries(attempt_id, seq);
CREATE INDEX deliveries_by_share   ON deliveries(share_token) WHERE share_token IS NOT NULL;
${appendOnly('deliveries')}

CREATE TABLE decisions (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  gate    TEXT NOT NULL,
  text    TEXT NOT NULL,
  at      TEXT NOT NULL ${JST('at')}
);
CREATE INDEX decisions_by_case ON decisions(case_id, seq);
${appendOnly('decisions')}

CREATE TABLE sessions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, session_id TEXT NOT NULL, label TEXT,
  at TEXT NOT NULL ${JST('at')}
);
CREATE INDEX sessions_by_id ON sessions(session_id, seq);
${appendOnly('sessions')}

CREATE TABLE notices (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
  at TEXT NOT NULL ${JST('at')}
);
CREATE INDEX notices_by_at ON notices(at);

CREATE TABLE conversation_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, who TEXT NOT NULL,
  text TEXT NOT NULL, choices TEXT, choice_id TEXT, at TEXT NOT NULL ${JST('at')}
);
CREATE INDEX conversation_by_thread ON conversation_messages(thread, seq);
`
