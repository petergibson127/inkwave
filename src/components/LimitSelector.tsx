// LimitSelector — footer component for setting the SCAS vocabulary cap.
//
// Renders a small unobtrusive control below the editor. The writer can:
//   - type a number between 500 and 30000
//   - toggle "infinite" (no red highlights)
//
// Default is 'infinite' for new documents so the writer isn't immediately
// confronted with red underlines before they've opted in.

import { useState } from 'react'

interface LimitSelectorProps {
  value: number | 'infinite'
  onChange: (next: number | 'infinite') => void
}

const MIN = 500
const MAX = 30000
const DEFAULT_N = 5000

export function LimitSelector({ value, onChange }: LimitSelectorProps) {
  // Local input state so the field can be edited mid-type without firing onChange.
  const [inputVal, setInputVal] = useState<string>(
    value === 'infinite' ? '' : String(value)
  )
  const [infinite, setInfinite] = useState(value === 'infinite')

  function handleToggleInfinite() {
    const next = !infinite
    setInfinite(next)
    if (next) {
      onChange('infinite')
    } else {
      const n = clamp(parseInt(inputVal, 10) || DEFAULT_N)
      setInputVal(String(n))
      onChange(n)
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputVal(e.target.value)
  }

  function handleInputBlur() {
    const parsed = parseInt(inputVal, 10)
    if (isNaN(parsed)) {
      setInputVal(String(DEFAULT_N))
      onChange(DEFAULT_N)
      return
    }
    const n = clamp(parsed)
    setInputVal(String(n))
    onChange(n)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  return (
    <div className="flex items-center gap-4 text-sm text-stone-400 select-none font-sans">
      <span className="tracking-wide uppercase text-xs">Vocab limit</span>

      {/* Number input */}
      <input
        type="number"
        min={MIN}
        max={MAX}
        value={infinite ? '' : inputVal}
        disabled={infinite}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        onKeyDown={handleKeyDown}
        placeholder={String(DEFAULT_N)}
        className={[
          'w-24 rounded border px-3 py-1 text-center text-sm',
          'bg-transparent border-stone-300 text-stone-500',
          'focus:outline-none focus:border-stone-400',
          infinite ? 'opacity-30 cursor-not-allowed' : '',
        ].join(' ')}
      />

      {/* Infinite toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={infinite}
          onChange={handleToggleInfinite}
          className="accent-stone-400 cursor-pointer"
        />
        <span>Infinite</span>
      </label>
    </div>
  )
}

function clamp(n: number): number {
  return Math.min(MAX, Math.max(MIN, n))
}
