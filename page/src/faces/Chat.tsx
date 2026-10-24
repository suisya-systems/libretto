// 会話欄（画面案 1 の「チャットで依頼する」と、画面案 2 の「話して内容を変える」。docs/implementation.md 6.2.1 (2)(3)(9)・6.2.2 (8)）
import { type ConversationMessage, ConversationView } from '@libretto/shared/api'
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { useLoad } from '../load.ts'
import { W } from '../wording.ts'
import { ProblemView } from './Pending.tsx'

const RETRY = 'retry' // ホストが失敗の行に付ける選択肢（6.2.1 (7)）
const MAX = 2000 // ConversationPost の text の上限

type Body = { text: string } | { choiceId: string }
type Sent = 'ok' | 'reload' | 'failed'

// 通信の失敗は同じ requestId で送り直す（6.2.1 (3)）。409 は取り直す
async function postMessage(
  body: Body & { requestId: string; lastSeq: number; caseId?: string; candidateId?: string },
): Promise<Sent> {
  try {
    const res = await fetch('/api/conversation/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 202) return 'ok'
    return res.status === 409 ? 'reload' : 'failed'
  } catch {
    return 'failed'
  }
}

// caseId があれば案件の中の会話（スレッド = 案件 id）、candidateId があれば候補の中の会話（「内容を修正」。6.4 (5)）
export function Chat({ stopped, caseId, candidateId }: { stopped: boolean; caseId?: string; candidateId?: string }) {
  const conv = useLoad(
    caseId
      ? `/api/conversation?caseId=${encodeURIComponent(caseId)}`
      : candidateId
        ? `/api/conversation?candidateId=${encodeURIComponent(candidateId)}`
        : '/api/conversation',
    ConversationView,
    (s) => s.event === 'conversation.message',
  )
  const L = candidateId
    ? {
        heading: W['cand.talkHeading'],
        label: W['cand.talkLabel'],
        placeholder: W['cand.talkPlaceholder'],
        note: W['cand.talkNote'],
        button: W['chat.send'],
      }
    : caseId
      ? {
          heading: W['talk.heading'],
          label: W['talk.label'],
          placeholder: W['talk.placeholder'],
          note: W['talk.note'],
          button: W['chat.send'],
        }
      : {
          heading: W['home.askHeading'],
          label: W['home.askLabel'],
          placeholder: W['home.askPlaceholder'],
          note: W['home.askNote'],
          button: W['home.askButton'],
        }
  // 1 つの面に会話欄が 2 つ並ぶ（ホームの依頼と候補の修正）ので、id はホームの依頼の欄以外で分ける
  const uid = useId()
  const ask = caseId || candidateId ? `ask${uid}` : 'ask'
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  // 失敗した送信の requestId は、同じ中身をもう一度押すまで持つ（届いていたかが画面からは分からない）
  const retry = useRef<{ key: string; id: string } | null>(null)
  const log = useRef<HTMLOListElement>(null)

  const messages = conv.data?.messages ?? []
  const pending = conv.data?.pending ?? false
  const last = messages.at(-1)
  const lastSeq = last?.seq ?? 0
  // 今の依頼の会話: 最後に案件になった返事より後（6.2.1 (6)）
  const fresh = messages.findLastIndex((m) => m.caseId) === messages.length - 1
  const locked = stopped || pending || sending || !conv.data
  const noReply = !pending && last?.who === '本人'

  // biome-ignore lint/correctness/useExhaustiveDependencies: 行が増えたとき・返事待ちが変わったときに下までスクロールする
  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending])

  async function send(body: Body) {
    const key = JSON.stringify(body)
    const id = retry.current?.key === key ? retry.current.id : crypto.randomUUID()
    retry.current = { key, id }
    setSending(true)
    setFailed(false)
    const r = await postMessage({
      ...body,
      requestId: id,
      lastSeq,
      ...(caseId && { caseId }),
      ...(candidateId && { candidateId }),
    })
    setSending(false)
    if (r === 'failed') return setFailed(true)
    retry.current = null
    // 送っている間に書き足した分は消さない
    if (r === 'ok' && 'text' in body) setDraft((d) => (d.trim() === body.text ? '' : d))
    conv.reload()
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const text = draft.trim()
    if (text && !locked) void send({ text })
  }
  // 変換中の Enter では送らない
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) submit()
  }

  return (
    <section aria-labelledby={`h-${ask}`} className="card ask chat">
      <h2 id={`h-${ask}`}>{L.heading}</h2>
      {/* 読めないまま送れない欄にしない（5.8 (3)） */}
      {conv.problem && <ProblemView problem={conv.problem} retry={conv.reload} />}
      {messages.length > 0 && (
        <ol ref={log} className="chat-log" aria-label={W['chat.log']} aria-live="polite">
          {messages.map((m, i) => (
            <Line
              key={m.seq}
              m={m}
              answer={messages[i + 1]?.who === '本人' ? messages[i + 1]?.choiceId : undefined}
              active={m === last && !locked}
              onChoose={(choiceId) => void send({ choiceId })}
            />
          ))}
          {pending && last?.who === '本人' && (
            <li className="msg msg-libretto">
              <span className="sr-only">{W['chat.who.libretto']}</span>
              <p className="bubble thinking" role="status">
                <span className="dots" aria-hidden="true" />
                {W['chat.thinking']}
              </p>
            </li>
          )}
          {noReply && (
            <li className="msg msg-libretto">
              <span className="sr-only">{W['chat.who.libretto']}</span>
              <div className="bubble bubble-alert">
                <p>{W['chat.noReply']}</p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={locked}
                  aria-busy={sending || undefined}
                  onClick={() => void send({ choiceId: RETRY })}
                >
                  {W['chat.retry']}
                </button>
              </div>
            </li>
          )}
        </ol>
      )}
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor={ask} className={fresh ? 'muted small' : 'sr-only'}>
          {L.label}
        </label>
        {stopped && (
          <p id={`${ask}-stopped`} className="small pending-note">
            {W['chat.stopped']}
          </p>
        )}
        <textarea
          id={ask}
          rows={fresh ? 3 : 2}
          placeholder={fresh ? L.placeholder : undefined}
          value={draft}
          maxLength={MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={stopped}
          aria-describedby={stopped ? `${ask}-stopped` : `${ask}-hint`}
        />
        <div className="row-between wrap">
          <div className="muted small">{fresh ? L.note : <span id={`${ask}-hint`}>{W['chat.hint']}</span>}</div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={locked || !draft.trim()}
            aria-busy={sending || undefined}
          >
            {fresh ? L.button : W['chat.send']}
          </button>
        </div>
        {failed && (
          <p className="small chat-failed" role="alert">
            {W['band.sendFailed']}
          </p>
        )}
      </form>
    </section>
  )
}

function Line({
  m,
  answer,
  active,
  onChoose,
}: {
  m: ConversationMessage
  answer: string | undefined
  active: boolean
  onChoose: (choiceId: string) => void
}) {
  return (
    <li className={`msg msg-${m.who === '本人' ? 'you' : 'libretto'}`}>
      <span className="sr-only">{W[`chat.who.${m.who}`]}</span>
      <div className={`bubble${m.caseId ? ' bubble-done' : ''}`}>
        <p>{m.text}</p>
        {m.caseId && (
          <Link href={`/cases/${m.caseId}`} className="btn btn-primary btn-sm">
            {W['chat.openCase']}
          </Link>
        )}
      </div>
      {m.choices && (
        <div className="choices">
          {m.choices.map((c) => {
            const chosen = answer === c.id
            return (
              <button
                key={c.id}
                type="button"
                className={`choice${c.recommended ? ' choice-rec' : ''}${chosen ? ' choice-chosen' : ''}`}
                disabled={!active}
                aria-pressed={answer ? chosen : undefined}
                onClick={() => onChoose(c.id)}
              >
                <span className="choice-label">
                  {c.label}
                  {c.recommended && <span className="badge b-you badge-sm">{W['chat.recommended']}</span>}
                  {chosen && <span className="sr-only">{W['chat.chosen']}</span>}
                </span>
                <span className="choice-why">{c.why}</span>
              </button>
            )
          })}
        </div>
      )}
    </li>
  )
}
