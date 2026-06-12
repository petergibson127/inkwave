// KickEvent emitter (v4 spec §7). A kick is a constraint encounter; on resolve (swap / justify /
// delete→credit / discharge) the controller emits a synchronous KickEvent. Subscribers: the
// snapshot trigger (M1) and, later, the cadence tap (M6). Kept tiny and framework-free.

import type { KickEvent } from '../types/document'

export type KickListener = (event: KickEvent) => void

export class KickEmitter {
  private listeners = new Set<KickListener>()

  /** Subscribe; returns an unsubscribe function. */
  on(listener: KickListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(event: KickEvent): void {
    for (const fn of this.listeners) fn(event)
  }
}
