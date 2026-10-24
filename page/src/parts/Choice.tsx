// Base UI のラジオ・チェックボックスと折りたたみを包む層（docs/implementation.md 5.5・5.8。部品を差し替えるときはこの層だけを直す）
import { Checkbox } from '@base-ui/react/checkbox'
import { CheckboxGroup } from '@base-ui/react/checkbox-group'
import { Collapsible } from '@base-ui/react/collapsible'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { type ReactNode, useState } from 'react'

export type Option = { value: string; label: ReactNode; note?: ReactNode; badge?: ReactNode }

// 1 つを選ぶ問い。選択肢はカードの形で、ラベル全体が押せる
export function Choose(p: {
  label: string
  value: string
  options: readonly Option[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <RadioGroup
      aria-label={p.label}
      className="radios"
      value={p.value}
      disabled={p.disabled ?? false}
      onValueChange={(v) => p.onChange(String(v))}
    >
      {p.options.map((o) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: Radio.Root が中の操作部品（role=radio）
        <label key={o.value} className="radio">
          <Radio.Root value={o.value} className="radio-dot">
            <Radio.Indicator className="radio-on" />
          </Radio.Root>
          <span className="radio-text">
            <span className="radio-label">
              {o.label}
              {o.badge}
            </span>
            {o.note && <span className="radio-note">{o.note}</span>}
          </span>
        </label>
      ))}
    </RadioGroup>
  )
}

// 小さな二択（承認の面の「【要確認】を付けて残す / この文を削る」）。押せる幅は 44px 以上
export function Segment(p: {
  label: string
  value: string
  options: readonly { value: string; label: ReactNode }[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <RadioGroup
      aria-label={p.label}
      className="segment"
      value={p.value}
      disabled={p.disabled ?? false}
      onValueChange={(v) => p.onChange(String(v))}
    >
      {p.options.map((o) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: Radio.Root が中の操作部品（role=radio）
        <label key={o.value} className="segment-item">
          <Radio.Root value={o.value} className="segment-dot" />
          <span>{o.label}</span>
        </label>
      ))}
    </RadioGroup>
  )
}

// 当てはまるものを全部選ぶ問い。カードの形はラジオと同じで、印だけ四角
export function ChooseMany(p: {
  label: string
  value: readonly string[]
  options: readonly Option[]
  disabled?: boolean
  onChange: (value: string[]) => void
}) {
  return (
    <CheckboxGroup
      aria-label={p.label}
      className="radios radios-many"
      value={[...p.value]}
      disabled={p.disabled ?? false}
      onValueChange={(v) => p.onChange(v)}
    >
      {p.options.map((o) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox.Root が中の操作部品（role=checkbox）
        <label key={o.value} className="radio">
          <Checkbox.Root value={o.value} className="radio-dot radio-box">
            <Checkbox.Indicator className="radio-tick">
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                  d="M2 6.5l2.6 2.6L10 3.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Checkbox.Indicator>
          </Checkbox.Root>
          <span className="radio-text">
            <span className="radio-label">
              {o.label}
              {o.badge}
            </span>
            {o.note && <span className="radio-note">{o.note}</span>}
          </span>
        </label>
      ))}
    </CheckboxGroup>
  )
}

// 開け閉めできる欄。trigger は開いているかで文言を変えられる
export function Fold(p: { trigger: (open: boolean) => ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="fold">
      <Collapsible.Trigger className="fold-trigger">{p.trigger(open)}</Collapsible.Trigger>
      <Collapsible.Panel className="fold-panel">{p.children}</Collapsible.Panel>
    </Collapsible.Root>
  )
}
