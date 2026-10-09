/**
 * Pure selection of the "attention" rows this overlay surfaces, derived from
 * the standard {@link SessionListState} plus the unified Session UI status
 * snapshot. That snapshot indexes one {@link SessionStatus} per Session,
 * carrying both facts this overlay surfaces: `pendingInteraction` (the
 * approval / plan-review / question awaiting an answer) and
 * `completionUnread` (a reply that finished outside the main view).
 * {@link selectAttention} merges the list with the status snapshot so the
 * caller drives both feeds through one pure derivation.
 *
 * The selector returns a plain, sorted array so a snapshot selector hook can
 * compare two derivations by value (see {@link attentionRowsKey}) without
 * touching React or the canvas.
 */
import type {
  PendingInteractionStatus, SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Attention kind union this overlay surfaces. */
export type AttentionKind = PendingInteractionStatus | 'completed'

/** One attention row the panel renders. */
export interface AttentionRow {
  kind: AttentionKind
  id: SessionId
  title: string
}

/** Display metadata per attention kind (color + localized label key). */
export const KIND_META: Readonly<Record<AttentionKind, { color: string }>> = {
  approval: { color: '#f59e0b' },
  'plan-review': { color: '#a78bfa' },
  question: { color: '#22d3ee' },
  completed: { color: '#34d399' },
}

/** Sort priority: a session awaiting the user outranks a finished one. */
export const KIND_PRIORITY: Readonly<Record<AttentionKind, number>> = {
  approval: 0,
  'plan-review': 1,
  question: 2,
  completed: 3,
}

/**
 * Map a domain pending-interaction kind to the three attention statuses this
 * overlay surfaces. Mirrors ui-workspace's {@code visiblePendingKind}:
 * unknown kinds do not surface.
 * @param kind - domain-owned interaction kind string.
 * @returns the matching attention status, or `undefined` for unknown kinds.
 */
export function attentionKindOf(kind: string | undefined): PendingInteractionStatus | undefined {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}

/**
 * Derive the attention rows from one session list snapshot plus the unified
 * Session UI status snapshot. Blank sessions never surface: a blank row is
 * a provisional New Session that cannot await anything. The currently-open
 * session surfaces like any other when its reply completes. A pending
 * interaction outranks a completed reminder for the same session.
 * @param state - the useSessions snapshot.
 * @param status - the useSessionStatus snapshot (Session id → status).
 * @returns the sorted attention rows.
 */
export function selectAttention(
  state: SessionListState,
  status?: SessionStatusSnapshot,
): AttentionRow[] {
  const rows: AttentionRow[] = []
  for (const id of state.ids) {
    const row: SessionSummary | undefined = state.byId[id]
    if (row === undefined || row.blank) continue
    const entry: SessionStatus | undefined = status?.get(id)
    const kind = attentionKindOf(entry?.pendingInteraction?.kind)
    if (kind !== undefined) {
      rows.push({ kind, id, title: row.displayTitle })
    } else if (entry?.completionUnread === true) {
      rows.push({ kind: 'completed', id, title: row.displayTitle })
    }
  }
  rows.sort((a, b) => {
    const pa = KIND_PRIORITY[a.kind]
    const pb = KIND_PRIORITY[b.kind]
    if (pa !== pb) return pa - pb
    // Session ids are unique within one list, so ids are never equal here; the
    // `: 0` arm is a closed-union backstop for a forged input.
    /* v8 ignore next */
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return rows
}

/**
 * Stable value key for two attention row arrays (hook equality).
 * @param rows - the attention rows to key.
 * @returns a `'kind|id|title'`-joined string that changes on any visible edit.
 */
export function attentionRowsKey(rows: readonly AttentionRow[]): string {
  return rows.map(r => r.kind + ':' + r.id + ':' + r.title).join('|')
}

/**
 * Whether every row is a background reply completion (drives the green theme).
 * @param rows - the attention rows to test.
 * @returns `true` only when `rows` is non-empty and every row is `completed`.
 */
export function isAllCompleted(rows: readonly AttentionRow[]): boolean {
  return rows.length > 0 && rows.every(r => r.kind === 'completed')
}
