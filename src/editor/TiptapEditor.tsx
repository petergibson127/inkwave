import { useEffect, useRef, useState, type RefObject } from 'react'
import { useEditor, EditorContent, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextStyle from '@tiptap/extension-text-style'
import FontFamily from '@tiptap/extension-font-family'
import TextAlign from '@tiptap/extension-text-align'
import { FontSize } from './extensions/FontSize'
import type { InkwaveDocument } from '../types/document'
import { scheduleSave } from '../storage/opfs'
import { upsertMeta } from '../storage/indexeddb'
import { RedHighlightExtension, SCAS_HINT_META } from './extensions/RedHighlightExtension'
import type { HintState } from './extensions/RedHighlightExtension'
import { REFLOW_OPEN_MS, type LineRange, type SlideRange } from './suggestions/ThesaurusPopover/popoverConstants'
import { ScasSlotMark } from './extensions/ScasSlotMark'
import { Scroll } from './Scroll'
import { ThesaurusPopover } from './suggestions/ThesaurusPopover'
import { CaretGutter } from './CaretGutter'
import { CycleHintPanel } from './suggestions/CycleHintPanel'
import { prefetchSynonyms } from './suggestions/thesaurus'
import { LimitSelector } from '../components/LimitSelector'
import { OptionsMenu } from '../components/OptionsMenu'
import { AccountControl } from '../components/AccountControl'
import { StyleBar } from '../components/StyleBar'
import { GuideMenu } from '../components/GuideMenu'
import { ComplianceContext, useComplianceProvider } from '../scas/compliance'
import { ScasController } from '../scas/controller'
import { normalizeScasState, DEFAULT_SET_SIZE } from '../scas/state'
import { createSnapshotIfChanged, listSnapshots, stampSnapshot, drainUnstamped, upgradePending } from '../provenance/snapshots'
import { ReceiptPanel } from '../components/ReceiptPanel'
import { SessionRunner } from '../provenance/session'
import { buildExportBundle, bundleFilename, downloadBundle } from '../provenance/bundle'
import { fileSaveAvailable, pickSaveFile, getSaveFileHandle, writeBundleToFile } from '../storage/folder'
import { oneDriveConfigured, oneDriveAccount, syncToOneDrive, startOneDriveSignIn, oneDriveSyncPending, clearOneDriveSyncPending, oneDrivePath, setChosenFolder, type OneDriveFolder } from '../storage/onedrive'
import { SyncStatus } from '../components/SyncStatus'
import { OneDriveFolderPicker } from '../components/OneDriveFolderPicker'
import { contentHash } from '../provenance/hash'
import { verifyChain, signingPublicKeyHex } from '../provenance/receipts'
import type { Snapshot, SignedReceipt, KickEvent } from '../types/document'

// Wall-clock resample cadence for the rotating exclusion set S_v (v4 spec §4.2: 20–60 s).
const RESAMPLE_INTERVAL_MS = 30_000

interface TiptapEditorProps {
  doc: InkwaveDocument
  onDocChange: (updated: InkwaveDocument) => void
}

export function TiptapEditor({ doc, onDocChange }: TiptapEditorProps) {
  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  // The SCAS engine controller (live state mirrored to doc.scasState for persistence). Created
  // lazily so it survives re-renders; reseated when the active document changes (see effect below).
  const scasRef = useRef<ScasController>()
  if (!scasRef.current) {
    scasRef.current = new ScasController(
      normalizeScasState(doc.scasState),
      doc.scasSeedRef ?? doc.scasSessionSeed,
      doc.id,
      doc.scasSetSize ?? DEFAULT_SET_SIZE,
    )
  }
  // Document content size last seen by onTransaction — a drop means content was deleted, which
  // gates the ban-credit lock detection (so a not-yet-committed word isn't mistaken for a delete).
  const prevDocSizeRef = useRef(-1)

  // Snapshots (the provenance record). Loaded per document; appended when a resolved kick changes
  // the content. createSnapshotIfChanged is serialised through a promise chain so rapid kicks can't
  // race the OPFS read-modify-write.
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const snapQueueRef = useRef<Promise<void>>(Promise.resolve())

  // Live-composition signing session (M3). The runner holds the server-issued S_v + the receipt
  // chain; null while opening or when the service is unreachable (then the controller falls back to
  // locally-derived S_v — composition degrades visibly rather than blocking writing).
  const sessionRef = useRef<SessionRunner | null>(null)
  const periodKicksRef = useRef<KickEvent[]>([]) // kicks resolved during the current signing period
  const [receipts, setReceipts] = useState<SignedReceipt[]>([])
  const [chainStatus, setChainStatus] = useState<string | null>(null)
  // Writer-held folder mirror (M4, Chromium only). Tracked in a ref read by the (non-React)
  // snapshot/period callbacks (saving/sync UI lives in the ⋮ menu, not the snapshots panel).
  const folderActiveRef = useRef(false)
  // OneDrive sync (Microsoft Graph) — cross-browser cloud storage for non-Chromium writers.
  const [oneDriveAcct, setOneDriveAcct] = useState<string | null>(null)
  const oneDriveActiveRef = useRef(false)
  const [lastSync, setLastSync] = useState<number | null>(null) // ms epoch of last successful OneDrive sync
  const [oneDriveUrl, setOneDriveUrl] = useState<string | null>(null) // webUrl of the synced file (open-in-OneDrive)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)

  const [currentParagraphIndex, setCurrentParagraphIndex] = useState(0)
  const [showHints, setShowHints] = useState(true)
  const [cycleActive, setCycleActive] = useState(false)
  const [containerRight, setContainerRight] = useState(0)
  const [paperRight, setPaperRight] = useState(0)
  // On a phone the toolbar hides while the keyboard is up to free the screen for writing,
  // and returns when the keyboard is dismissed. We detect the keyboard via the visual
  // viewport (its visible height shrinks when the keyboard shows) — far more reliable than
  // editor focus, whose blur doesn't fire on iOS when the keyboard is dismissed (which left
  // the toolbar stuck hidden) and whose churn on a control tap made the bar "run away".
  const [keyboardUp, setKeyboardUp] = useState(false)
  // Formatting (font/size/align) is per-selection via marks, persisted in the content.
  const [styleBarOpen, setStyleBarOpen] = useState(false)
  const [selectionEmpty, setSelectionEmpty] = useState(true)
  const [styleScrollHidden, setStyleScrollHidden] = useState(false)
  const styleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ref to the relative container div — passed to ThesaurusPopover for accurate positioning.
  const containerRef = useRef<HTMLDivElement>(null)
  // Ref to the parchment/scroll column — its right edge anchors the options panel.
  const paperRef = useRef<HTMLDivElement>(null)
  // Footer bar + live mirrors of derived flags, read by the caret-keep-visible handler.
  const footerRef = useRef<HTMLDivElement>(null)
  const keyboardUpRef = useRef(false)
  const barVisibleRef = useRef(false)

  // Shared mutable ref read synchronously by the decoration plugin.
  const hintStateRef = useRef<HintState>({ focusedPos: null, showHints: true, focusedMinWidth: null, lineCompressionRange: null, animate: true, durationMs: REFLOW_OPEN_MS, slideRange: null })

  // Debounced prefetch — fires after typing pauses so popover opens instantly.
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const compliance = useComplianceProvider()

  // Keep showHints in sync with the ref and force a decoration rebuild.
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)
  useEffect(() => {
    hintStateRef.current = { ...hintStateRef.current, showHints }
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      ed.view.dispatch(ed.state.tr.setMeta(SCAS_HINT_META, true))
    }
  }, [showHints])

  function handleHintChange(
    pos: number | null,
    minWidth?: number | null,
    lineRange?: LineRange | null,
    animate: boolean = true,
    durationMs: number = REFLOW_OPEN_MS,
    slideRange?: SlideRange | null,
  ) {
    hintStateRef.current = {
      ...hintStateRef.current,
      focusedPos: pos,
      focusedMinWidth: minWidth ?? null,
      lineCompressionRange: lineRange ?? null,
      animate,
      durationMs,
      // omitted (undefined) → keep the current slide; null → clear it; object → set it.
      slideRange: slideRange === undefined ? hintStateRef.current.slideRange : slideRange,
    }
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      ed.view.dispatch(ed.state.tr.setMeta(SCAS_HINT_META, true))
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      ScasSlotMark,
      TextStyle,
      FontFamily,
      FontSize,
      TextAlign.configure({ types: ['paragraph'] }),
      // Single Enter = hard break (stay in paragraph).
      // Double Enter (Shift+Enter) = new paragraph.
      Extension.create({
        name: 'enterBehavior',
        addKeyboardShortcuts() {
          return {
            'Enter':       () => this.editor.commands.setHardBreak(),
            'Shift-Enter': () => this.editor.chain().splitBlock().run(),
          }
        },
      }),
      RedHighlightExtension.configure({
        getDoc: () => docRef.current,
        getHintState: () => hintStateRef.current,
        getScasLookup: () => scasRef.current!.lookup(),
      }),
    ],
    content: doc.contentJson,
    editorProps: {
      attributes: {
        class: 'tiptap-editor',
        'data-placeholder': 'Begin writing…',
        spellcheck: 'false',
      },
    },
    onTransaction: ({ editor: e, transaction }) => {
      const current = docRef.current

      // ── SCAS: drive the engine off the committed words ───────────────────────
      // Only on a real content change (skip the no-op SCAS_HINT_META repaint we dispatch below,
      // which would otherwise re-enter here with docChanged=false).
      let scasState = current.scasState
      if (transaction.docChanged) {
        const scas = scasRef.current!
        const size = e.state.doc.content.size
        const hadDeletion = prevDocSizeRef.current >= 0 && size < prevDocSizeRef.current
        prevDocSizeRef.current = size
        if (scas.processDoc(e.state.doc, e.state.selection.from, hadDeletion)) {
          scasState = scas.state
          // The decoration plugin already ran for THIS transaction with the pre-update lookup;
          // repaint with the new state in a microtask (avoids dispatching mid-dispatch).
          queueMicrotask(() => {
            if (!e.isDestroyed) e.view.dispatch(e.state.tr.setMeta(SCAS_HINT_META, true))
          })
        }
      }

      const updated: InkwaveDocument = {
        ...current,
        contentJson: e.getJSON(),
        updatedAt: new Date().toISOString(),
        title: deriveTitle(e.getText()) || current.title,
        scasState,
      }
      docRef.current = updated
      onDocChange(updated)
      scheduleSave(updated)
      void upsertMeta({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
      })

      // Prefetch synonyms for all visible red words after a short pause.
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
      prefetchTimerRef.current = setTimeout(() => {
        const words = Array.from(
          e.view.dom.querySelectorAll<HTMLElement>('.scas-red')
        ).map(el => el.dataset.word ?? '').filter(Boolean)
        if (words.length > 0) prefetchSynonyms([...new Set(words)])
      }, 600)

      const { $from } = e.state.selection
      let pIdx = 0
      e.state.doc.nodesBetween(0, $from.pos, (node) => {
        if (node.type.name === 'paragraph') pIdx++
      })
      setCurrentParagraphIndex(Math.max(0, pIdx - 1))
    },
  })

  // Keep editorRef in sync so the hint-change handler can reach the editor.
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  // DEV-ONLY: expose SCAS internals for manual/automated inspection. Stripped from prod builds.
  useEffect(() => {
    if (import.meta.env.DEV && editor) {
      ;(window as unknown as { __scas?: unknown }).__scas = {
        get state() { return scasRef.current!.state },
        get lookup() { const l = scasRef.current!.lookup(); return { version: l.version, locked: [...l.locked], liveKicks: [...l.liveKicks], immune: [...l.immune] } },
        inSv: (lemma: string) => scasRef.current!.inSv(lemma),
        get hint() { return hintStateRef.current },
        get session() {
          const r = sessionRef.current
          return r ? { token: r.sessionToken.slice(0, 12), setVersion: r.current.setVersion, receipts: r.receipts.length } : null
        },
        runPeriod: () => runPeriodRef.current(), // fire a signing period now (test/debug)
      }
    }
  }, [editor])

  // Track whether the selection is collapsed — on touch the toolbar hides while typing
  // (empty selection) but stays up when text is selected so it can be formatted.
  useEffect(() => {
    if (!editor) return
    const upd = () => setSelectionEmpty(editor.state.selection.empty)
    // A real selection change re-arms the style bar after a scroll dismissed it.
    const onSel = () => { const empty = editor.state.selection.empty; setSelectionEmpty(empty); if (!empty) setStyleScrollHidden(false) }
    upd()
    editor.on('selectionUpdate', onSel)
    editor.on('transaction', upd)
    return () => { editor.off('selectionUpdate', onSel); editor.off('transaction', upd) }
  }, [editor])

  // Scrolling down dismisses the style bar (button- or selection-driven), on phone and
  // desktop. It re-appears on the next selection change or STYLE press, not on scroll-up.
  useEffect(() => {
    let lastY = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      if (y > lastY + 4) { setStyleScrollHidden(true); setStyleBarOpen(false) }
      lastY = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Detect the on-screen keyboard from the visual viewport: when it's up, the visible height
  // drops well below the LARGEST height seen (its no-keyboard height). Comparing to the
  // tracked max — rather than to window.innerHeight — is robust to iOS quirks where
  // innerHeight tracks the keyboard, and we ignore offsetTop (a scroll offset, not the
  // keyboard) so page scroll doesn't fool it. 150px threshold ignores URL-bar resizes.
  const kbMaxRef = useRef(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onVV = () => {
      kbMaxRef.current = Math.max(kbMaxRef.current, vv.height)
      setKeyboardUp(vv.height < kbMaxRef.current - 150)
    }
    const onOrient = () => { kbMaxRef.current = vv.height; setKeyboardUp(false) }
    onVV()
    vv.addEventListener('resize', onVV)
    window.addEventListener('orientationchange', onOrient)
    return () => { vv.removeEventListener('resize', onVV); window.removeEventListener('orientationchange', onOrient) }
  }, [])

  // Keep the caret above the keyboard / bottom toolbar. While the keyboard is up, if typing or
  // a caret move would put the caret below the keyboard top (or the visible bar above it),
  // scroll down just enough to lift it back into view. Reads live values via refs so the
  // editor subscription can be set up once. No-op while the keyboard is down (desktop too).
  const keepCaretRef = useRef<() => void>(() => {})
  keepCaretRef.current = () => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed || !keyboardUpRef.current) return
    const vv = window.visualViewport
    let obstructionTop = vv ? vv.offsetTop + vv.height : window.innerHeight
    if (footerRef.current && barVisibleRef.current) {
      const t = footerRef.current.getBoundingClientRect().top
      if (t > 0 && t < obstructionTop) obstructionTop = t
    }
    let caretBottom: number
    try { caretBottom = ed.view.coordsAtPos(ed.state.selection.head).bottom } catch { return }
    const overshoot = caretBottom - (obstructionTop - 12)
    if (overshoot > 4) window.scrollBy(0, overshoot)
  }
  useEffect(() => {
    if (!editor) return
    let raf = 0
    const onChange = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => keepCaretRef.current()) }
    editor.on('selectionUpdate', onChange)
    editor.on('update', onChange)
    return () => { editor.off('selectionUpdate', onChange); editor.off('update', onChange); cancelAnimationFrame(raf) }
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps
  // When the keyboard opens, the caret may already be behind it — lift it once.
  useEffect(() => {
    if (keyboardUp) requestAnimationFrame(() => keepCaretRef.current())
  }, [keyboardUp])

  // Track the container's right edge in viewport coords so CycleHintPanel
  // can sit flush against it at any window size or zoom level.
  useEffect(() => {
    function update() {
      if (containerRef.current)
        setContainerRight(containerRef.current.getBoundingClientRect().right)
      if (paperRef.current)
        setPaperRight(paperRef.current.getBoundingClientRect().right)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])


  // Warm the synonym cache as soon as the editor is ready (existing red words).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    requestAnimationFrame(() => {
      const words = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>('.scas-red')
      ).map(el => el.dataset.word ?? '').filter(Boolean)
      if (words.length > 0) prefetchSynonyms([...new Set(words)])
    })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const currentContent = JSON.stringify(editor.getJSON())
    const incomingContent = JSON.stringify(doc.contentJson)
    if (currentContent !== incomingContent) {
      editor.commands.setContent(doc.contentJson, false)
    }
  }, [doc.id, editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Switching to a different document → reseat the controller onto its persisted state.
  useEffect(() => {
    scasRef.current!.reseat(
      normalizeScasState(docRef.current.scasState),
      docRef.current.scasSeedRef ?? docRef.current.scasSessionSeed,
      docRef.current.id,
      docRef.current.scasSetSize ?? DEFAULT_SET_SIZE,
    )
    prevDocSizeRef.current = -1
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(SCAS_HINT_META, true))
  }, [doc.id, editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Serialise all snapshot-file mutations through one promise chain (avoids OPFS read-modify-write
  // races between snapshot creation, OTS stamping, and upgrades).
  function enqueueSnapshotWork(work: () => Promise<void>) {
    snapQueueRef.current = snapQueueRef.current
      .then(work)
      .catch((err) => { console.warn('[inkwave] snapshot work failed:', err) })
  }
  const refreshSnapshots = async (docId: string) => { setSnapshots(await listSnapshots(docId)) }

  // Load existing snapshots when the document opens / switches, then (online) stamp any unstamped
  // backlog and upgrade pending proofs toward Bitcoin confirmation.
  useEffect(() => {
    const docId = doc.id
    void listSnapshots(docId).then(setSnapshots)
    enqueueSnapshotWork(async () => {
      await drainUnstamped(docId)
      await upgradePending(docId)
      await refreshSnapshots(docId)
    })
  }, [doc.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Snapshot trigger: on a resolved kick, snapshot if the content hash changed (M1), then anchor it
  // to Bitcoin via OpenTimestamps (M2 → pending in seconds). Ordinary typing / pastes resolve no
  // kick, so they never snapshot.
  useEffect(() => {
    if (!editor) return
    const off = scasRef.current!.kicks.on((event) => {
      periodKicksRef.current.push(event) // buffer for the next signed period (M3)
      enqueueSnapshotWork(async () => {
        // Anchor the receipt chain so far into the snapshot's bundleHash (so OTS commits to it).
        const snap = await createSnapshotIfChanged(docRef.current, 'kick', sessionRef.current?.receipts ?? [])
        if (!snap) return
        setSnapshots((prev) => [...prev, snap])
        const stamped = await stampSnapshot(snap.documentId, snap.id) // pending proof
        if (stamped) setSnapshots((prev) => prev.map((s) => (s.id === stamped.id ? stamped : s)))
        mirrorIfActive()
      })
    })
    return off
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Manual "check Bitcoin" — upgrade pending proofs toward confirmation (also runs on load).
  function checkBitcoin() {
    const docId = docRef.current.id
    enqueueSnapshotWork(async () => { await upgradePending(docId); await refreshSnapshots(docId) })
  }

  // Export the self-verifying bundle (content + snapshots + receipts + key ref) for /verify (M4).
  function exportBundle() {
    const bundle = buildExportBundle(docRef.current, snapshots)
    downloadBundle(bundle, bundleFilename(docRef.current))
  }

  // Primary "Save" — works on every browser. Chromium (Chrome/Edge/Brave) mirrors to a granted
  // folder via File System Access; Firefox/Safari (no folder API) download the record instead.
  function saveRecord() {
    if (fileSaveAvailable()) void saveToFile()
    else exportBundle()
  }

  // Mirror the record to whatever the writer linked — a granted folder (Chromium) and/or OneDrive
  // (any browser). No-op if neither is active. OneDrive auto-sync is silent (no popup); if the
  // token has expired it simply skips until the next explicit sync.
  function mirrorIfActive() {
    if (!folderActiveRef.current && !oneDriveActiveRef.current) return
    const docId = docRef.current.id
    void listSnapshots(docId).then((snaps) => {
      if (folderActiveRef.current) void writeBundleToFile(docRef.current, snaps).catch(() => {})
      if (oneDriveActiveRef.current) void syncToOneDrive(docRef.current, snaps).then((r) => { if (r.ok) { setLastSync(Date.now()); setOneDriveUrl(r.webUrl) } }).catch(() => {})
    }).catch(() => {})
  }

  // "Sync to OneDrive". If signed in → sync silently now. If not → start the same-window sign-in
  // redirect (sets a pending flag); on return we sync automatically (see the reconnect effect).
  async function syncOneDrive() {
    const acct = await oneDriveAccount()
    if (!acct) { await startOneDriveSignIn(); return } // navigates away, comes back signed in
    const snaps = await listSnapshots(docRef.current.id)
    const r = await syncToOneDrive(docRef.current, snaps)
    if (r.ok) {
      oneDriveActiveRef.current = true
      setOneDriveAcct(acct)
      setLastSync(Date.now())
      setOneDriveUrl(r.webUrl)
    } else {
      // Signed in but the token/scope isn't valid (e.g. the new Files.ReadWrite consent) → re-consent.
      await startOneDriveSignIn()
    }
  }

  // Choose which OneDrive folder to sync into. Needs a signed-in session; otherwise start sign-in
  // (we resume on return). On pick, remember the folder and sync there now.
  async function chooseOneDriveFolder() {
    const acct = await oneDriveAccount()
    if (!acct) { await startOneDriveSignIn(); return }
    setFolderPickerOpen(true)
  }
  function onFolderPicked(folder: OneDriveFolder) {
    setChosenFolder(folder)
    setFolderPickerOpen(false)
    void syncOneDrive()
  }

  // Reconnect a prior OneDrive session on load (also completes a sign-in we returned from).
  useEffect(() => {
    if (!oneDriveConfigured()) return
    void oneDriveAccount().then((acc) => {
      oneDriveActiveRef.current = !!acc
      setOneDriveAcct(acc)
      if (acc && oneDriveSyncPending()) {
        clearOneDriveSyncPending()
        void listSnapshots(docRef.current.id)
          .then((s) => syncToOneDrive(docRef.current, s))
          .then((r) => { if (r.ok) { setLastSync(Date.now()); setOneDriveUrl(r.webUrl) } })
      }
    })
  }, [])

  // "Save" — on first use, open the save-file picker so the writer names + places their single
  // .trace.json; after that, write back to the same file. The picker must run inside the click's
  // gesture, so on first save we call it FIRST (no await before it).
  async function saveToFile() {
    if (!folderActiveRef.current) {
      const handle = await pickSaveFile(docRef.current) // picker is the first call inside → in-gesture
      if (!handle) return
      folderActiveRef.current = true
    } else {
      const ok = await getSaveFileHandle(true)
      if (!ok) { folderActiveRef.current = false; return }
    }
    const snaps = await listSnapshots(docRef.current.id)
    await writeBundleToFile(docRef.current, snaps)
  }

  // Reconnect to a previously-chosen save file on load (no prompt if permission persists).
  useEffect(() => {
    void getSaveFileHandle().then((h) => { folderActiveRef.current = !!h })
  }, [])

  // Open a live-composition signing session when the document opens / switches. On success the
  // controller adopts the server's S_v; on failure (offline / service down) we leave the session
  // null and the controller keeps its locally-derived S_v (composition degrades visibly).
  useEffect(() => {
    let cancelled = false
    sessionRef.current = null
    periodKicksRef.current = []
    setReceipts([])
    setChainStatus(null)
    const docId = doc.id
    void SessionRunner.open(docId).then((runner) => {
      if (cancelled || !runner || docRef.current.id !== docId) return
      sessionRef.current = runner
      scasRef.current!.useServerSet(runner.current.lemmas, runner.current.setVersion)
      if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(SCAS_HINT_META, true))
    })
    return () => { cancelled = true }
  }, [doc.id, editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // The signing period. With a session: sign the period's receipt (content + resolved kicks), chain
  // it, and adopt the next server-issued set. Without one: fall back to a local resample (M0).
  // Verdicts are frozen (locked ∪ liveKicks persist), so neither reflows committed text. Held in a
  // ref so the interval always runs the latest closure (no stale editor/refs).
  const runPeriodRef = useRef<() => void>(() => {})
  runPeriodRef.current = () => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    const runner = sessionRef.current
    if (runner) {
      void (async () => {
        const kicks = periodKicksRef.current
        const cHash = await contentHash(docRef.current.contentJson)
        const receipt = await runner.closePeriod(cHash, kicks)
        if (!receipt) return // offline — keep the kicks buffered, retry next period
        periodKicksRef.current = []
        scasRef.current!.useServerSet(runner.current.lemmas, runner.current.setVersion)
        setReceipts([...runner.receipts])
        const updated: InkwaveDocument = {
          ...docRef.current,
          scasState: scasRef.current!.state,
          scasReceipts: [...runner.receipts],
        }
        docRef.current = updated
        onDocChange(updated)
        scheduleSave(updated)
        mirrorIfActive()
        if (!ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta(SCAS_HINT_META, true))
      })()
    } else {
      scasRef.current!.resampleNow()
      const updated: InkwaveDocument = { ...docRef.current, scasState: scasRef.current!.state }
      docRef.current = updated
      onDocChange(updated)
      scheduleSave(updated)
    }
  }
  useEffect(() => {
    if (!editor) return
    const id = setInterval(() => runPeriodRef.current(), RESAMPLE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Verify the held receipt chain against the published key (the guarantee, client-side).
  function verifyReceiptChain() {
    const runner = sessionRef.current
    if (!runner || runner.receipts.length === 0) { setChainStatus('no receipts yet'); return }
    void verifyChain(runner.receipts, runner.sessionToken, signingPublicKeyHex()).then((v) => {
      setChainStatus(v.ok ? `✓ ${v.verified} receipts verified` : `✗ ${v.reason}`)
    })
  }

  function handleLimitChange(next: number | 'infinite') {
    const updated: InkwaveDocument = {
      ...docRef.current,
      scasLimitN: next,
      updatedAt: new Date().toISOString(),
    }
    docRef.current = updated
    onDocChange(updated)
    scheduleSave(updated)
    // Re-focusing keeps the cursor in the editor on desktop; on a phone it would re-open
    // the keyboard and hide the toolbar (so the toolbar appears to "run away" when you
    // tap its controls), so skip the re-focus on touch-only devices.
    if (!window.matchMedia?.('(pointer: coarse) and (hover: none)')?.matches) {
      editor?.commands.focus()
    }
  }

  // Hide the toolbar only on touch-only devices (phones/tablets — they have no hover)
  // while the keyboard is up. Touchscreen laptops keep it (they report hover via trackpad).
  const isTouch = typeof window !== 'undefined'
    && window.matchMedia?.('(pointer: coarse) and (hover: none)')?.matches === true

  // A button-opened style bar auto-closes after π seconds of inactivity; each style
  // interaction (via onActivity) restarts the timer. Bars shown because text is
  // selected stay put (driven by the selection, not this flag).
  function armStyleTimer() {
    if (styleTimerRef.current) clearTimeout(styleTimerRef.current)
    styleTimerRef.current = setTimeout(() => setStyleBarOpen(false), 3141.5)
  }
  function toggleStyleBar() {
    const next = !styleBarOpen
    setStyleBarOpen(next)
    if (next) { setStyleScrollHidden(false); armStyleTimer() }
    else if (styleTimerRef.current) { clearTimeout(styleTimerRef.current); styleTimerRef.current = null }
  }

  // The style bar pops up whenever text is selected (flush above the keyboard) or when
  // opened with the STYLE button. The main row hides while the editor is focused on touch
  // (typing or selecting), so a selection brings up the style bar alone.
  const showStyle  = !!editor && (styleBarOpen || !selectionEmpty) && !styleScrollHidden
  const showMain   = !isTouch || !keyboardUp
  const barVisible = showStyle || showMain
  keyboardUpRef.current = keyboardUp
  barVisibleRef.current = barVisible

  return (
    <ComplianceContext.Provider value={compliance}>
      <div>
        <Scroll paperRef={paperRef} containerRef={containerRef}>
          <EditorContent editor={editor} />
          {editor && (
            <CaretGutter editor={editor} containerEl={containerRef as RefObject<HTMLDivElement>} side="left" />
          )}
          {editor && (
            <CaretGutter editor={editor} containerEl={containerRef as RefObject<HTMLDivElement>} side="right" />
          )}
          {editor && (
            <ThesaurusPopover
              editor={editor}
              paragraphIndex={currentParagraphIndex}
              containerEl={containerRef as RefObject<HTMLDivElement>}
              onHintChange={handleHintChange}
              onCycleChange={setCycleActive}
              isLockedLemma={(lemma) => scasRef.current!.lookup().locked.has(lemma)}
            />
          )}
        </Scroll>

        <CycleHintPanel active={cycleActive} showHints={showHints} containerRight={containerRight} />

        <ReceiptPanel
          snapshots={snapshots}
          onCheckBitcoin={checkBitcoin}
          receiptCount={receipts.length}
          chainStatus={chainStatus}
          onVerifyChain={verifyReceiptChain}
        />

        <SyncStatus
          account={oneDriveAcct}
          lastSync={lastSync}
          path={oneDriveAcct ? oneDrivePath(doc) : null}
          webUrl={oneDriveUrl}
          onChangeFolder={chooseOneDriveFolder}
        />

        {folderPickerOpen && (
          <OneDriveFolderPicker onPick={onFolderPicked} onClose={() => setFolderPickerOpen(false)} />
        )}

        {/* Footer bar. On a phone it docks flush to the bottom (the top of the Safari URL
            bar) with flat bottom corners; on desktop it floats as a rounded pill. */}
        <div
          className="fixed bottom-0 left-0 right-0 flex justify-center pointer-events-none"
          style={{ paddingBottom: isTouch ? 'env(safe-area-inset-bottom)' : '1rem' }}
        >
          <div
            ref={footerRef}
            className={`pointer-events-auto flex flex-col bg-white shadow-sm ${isTouch ? 'w-full' : ''}`}
            style={{
              border: '1px solid rgba(92, 45, 138, 0.75)',
              borderRadius: isTouch ? '15px 15px 0 0' : '15px',
              opacity: barVisible ? 1 : 0,
              pointerEvents: barVisible ? 'auto' : 'none',
              transition: 'opacity 160ms ease',
            }}
          >
            {/* Flat style sub-bar — flush above the keyboard (when text is selected) or
                above the main controls (when opened with the STYLE button) */}
            {showStyle && editor && (
              <div className={`flex items-center px-4 py-2 ${showMain ? 'border-b border-stone-200' : ''}`}>
                <StyleBar editor={editor} onActivity={armStyleTimer} />
              </div>
            )}

            {/* Main toolbar row */}
            {showMain && (
            <div className={`flex items-center px-4 py-2 ${isTouch ? 'justify-between' : 'gap-4'}`}>
              <LimitSelector
                value={doc.scasLimitN}
                onChange={handleLimitChange}
              />
              <label className="flex items-center gap-1.5 text-xs text-stone-400 cursor-pointer select-none font-serif">
                <input
                  type="checkbox"
                  checked={showHints}
                  onChange={e => setShowHints(e.target.checked)}
                  className="accent-stone-400"
                />
                hints
              </label>
              <button
                type="button"
                aria-pressed={styleBarOpen}
                onClick={toggleStyleBar}
                className={`uppercase tracking-wide text-xs transition-colors font-serif ${styleBarOpen ? 'text-[#5c2d8a]' : 'text-stone-400 hover:text-[#5c2d8a]'}`}
              >
                style
              </button>
              <GuideMenu />
              <AccountControl />
              <OptionsMenu
                paperRight={paperRight}
                onExportBundle={exportBundle}
                onSave={saveRecord}
                folderAvailable={fileSaveAvailable()}
                onSyncOneDrive={oneDriveConfigured() ? syncOneDrive : undefined}
                onChooseOneDriveFolder={chooseOneDriveFolder}
                oneDriveAccount={oneDriveAcct}
              />
            </div>
            )}
          </div>
        </div>
      </div>
    </ComplianceContext.Provider>
  )
}

function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0]?.trim() ?? ''
  return first.slice(0, 80)
}
