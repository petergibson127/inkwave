// OptionsMenu — kebab button at the right of the footer toolbar.
//
// Opens a small menu of app actions. "About" navigates to its own page; the rest
// open empty centred modals over the editor (placeholders for now).

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type ModalKey = 'login' | 'save' | 'recent' | 'open' | 'settings'

const MODAL_TITLES: Record<ModalKey, string> = {
  login:    'Login',
  save:     'Save',
  recent:   'Open Recent',
  open:     'Open',
  settings: 'Settings',
}

const INK = '#5c2d8a'

export function OptionsMenu() {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [modal, setModal] = useState<ModalKey | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  const items: Array<{ label: string; run: () => void }> = [
    { label: 'About',       run: () => navigate('/about') },
    { label: 'Login',       run: () => setModal('login') },
    { label: 'Save',        run: () => setModal('save') },
    { label: 'Open Recent', run: () => setModal('recent') },
    { label: 'Open',        run: () => setModal('open') },
    { label: 'Settings',    run: () => setModal('settings') },
  ]

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger (kebab) */}
      <button
        type="button"
        aria-label="Options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(o => !o)}
        className="flex items-center justify-center w-7 h-7 rounded-full text-stone-400 hover:text-[#5c2d8a] hover:bg-stone-100 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5"  r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>

      {/* Options menu — pops up above the button (the toolbar sits at the bottom) */}
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 bottom-full mb-2 z-[60] w-44 py-1 bg-white shadow-md text-sm text-stone-600 font-sans"
          style={{ border: `1px solid ${INK}66`, borderRadius: '10px' }}
        >
          {items.map(it => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={() => { setMenuOpen(false); it.run() }}
              className="w-full text-left px-4 py-1.5 hover:bg-stone-100 hover:text-[#5c2d8a] transition-colors"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {/* Centred modal for the non-About items (empty placeholders for now) */}
      {modal && <Modal title={MODAL_TITLES[modal]} onClose={() => setModal(null)} />}
    </div>
  )
}

function Modal({ title, onClose }: { title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-stone-900/20" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={e => e.stopPropagation()}
        className="relative bg-white w-full max-w-md min-h-[14rem] p-6 flex flex-col shadow-xl"
        style={{ border: `1px solid ${INK}bf`, borderRadius: '14px' }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-serif" style={{ color: INK }}>{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-stone-400 hover:text-[#5c2d8a] text-2xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1" />
      </div>
    </div>
  )
}
