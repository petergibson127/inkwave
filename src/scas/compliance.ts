// Compliance tracking — running ratio of accepted/(accepted+ignored) suggestions.
//
// Exposed via a React context + hook so any component can read or update it.
// The full provenance event log arrives in Week 3; for now we just maintain
// the counts in memory and persist them to the document via onDocChange.

import { createContext, useCallback, useContext, useState } from 'react'

interface ComplianceState {
  accepted: number
  ignored: number
}

interface ComplianceContextValue {
  accepted: number
  ignored: number
  /** Compliance percentage 0–100, or null if no interactions yet. */
  compliancePct: number | null
  recordAccepted: () => void
  recordIgnored: () => void
  reset: () => void
}

// eslint-disable-next-line react-refresh/only-export-components
export const ComplianceContext = createContext<ComplianceContextValue | null>(null)

/** Hook to read and update compliance state. Must be used inside ComplianceProvider. */
// eslint-disable-next-line react-refresh/only-export-components
export function useCompliance(): ComplianceContextValue {
  const ctx = useContext(ComplianceContext)
  if (!ctx) throw new Error('useCompliance must be used inside <ComplianceProvider>')
  return ctx
}

/** Provider — mount once at the editor root level. */
export function useComplianceProvider(initial?: ComplianceState): ComplianceContextValue {
  const [state, setState] = useState<ComplianceState>(
    initial ?? { accepted: 0, ignored: 0 }
  )

  const recordAccepted = useCallback(() => {
    setState((s) => ({ ...s, accepted: s.accepted + 1 }))
  }, [])

  const recordIgnored = useCallback(() => {
    setState((s) => ({ ...s, ignored: s.ignored + 1 }))
  }, [])

  const reset = useCallback(() => {
    setState({ accepted: 0, ignored: 0 })
  }, [])

  const total = state.accepted + state.ignored
  const compliancePct = total === 0 ? null : Math.round((state.accepted / total) * 100)

  return {
    accepted: state.accepted,
    ignored: state.ignored,
    compliancePct,
    recordAccepted,
    recordIgnored,
    reset,
  }
}
