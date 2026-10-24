// 会話欄の依頼ごとの区切りと送り直しの印（docs/implementation.md 6.2.1 (3)(6)）
export default `
ALTER TABLE conversation_messages ADD COLUMN case_id TEXT;
ALTER TABLE conversation_messages ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX conversation_one_per_request ON conversation_messages(request_id) WHERE request_id IS NOT NULL;
`
