// Base UI を包む層（docs/implementation.md 5.5・5.8）。部品を差し替えるときはこの層だけを直す
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useState } from 'react'

type ConfirmProps = {
  trigger: string
  title: string
  body: string
  confirm: string
  cancel: string
  disabled?: boolean
  busy?: boolean
  danger?: boolean
  triggerClass?: string
  onConfirm: () => void
}

// 押すと確かめてから実行する操作（止める・取り消す）。フォーカスは閉じると押したボタンに戻る
export function Confirm(p: ConfirmProps) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger
        className={p.triggerClass ?? 'btn btn-secondary'}
        disabled={p.disabled || p.busy}
        aria-busy={p.busy || undefined}
      >
        {p.trigger}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Popup className="dialog">
          <AlertDialog.Title className="dialog-title">{p.title}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-body">{p.body}</AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Close className="btn btn-secondary">{p.cancel}</AlertDialog.Close>
            <button
              type="button"
              className={p.danger ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={() => {
                setOpen(false)
                p.onConfirm()
              }}
            >
              {p.confirm}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
