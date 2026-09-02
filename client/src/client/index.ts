/**
 * Session-attention overlay plugin, browser half: two entries contributed to
 * the root-scoped `shell.overlay` list slot (owned and declared by ui-layout).
 * The visible entry watches the standard `useSessions` feed (the same data
 * the sidebar status dots use) and renders a character that peeks in from the
 * top-right edge, jumps out to play a kind-specific dance while any session
 * awaits the user's action (approval / plan review / question) or a background
 * session's AI reply finished unopened, then retreats back to its peek pose
 * when all sessions are handled. The invisible toast bridge watches the same
 * feed with the same derivation and reports sessions entering attention to
 * this package's host half (the `sessionAttentionToast` Remote service) so
 * the desktop toasts mirror the overlay's rule. Copy rides injected
 * defaults; there is no locale namespace of its own.
 *
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell.overlay SlotMap declaration (the key's owner)
// into this program so the overlay registrations below typecheck against the
// real declaration — no runtime edge to ui-layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard-hook merge (useSessions on root props).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { AttentionPanel } from './AttentionPanel.tsx'
import type { SessionAttentionInjected, ToastBridgeInjected } from './contract/slots.ts'
import { ToastBridge } from './toast-bridge.tsx'
import { TYPERT_REMOTE, type SessionAttentionToastRemoteNamespace } from './typert.ts'
import type { ToastSendRequest } from '../types.ts'

export type { SessionAttentionInjected, ToastBridgeInjected } from './contract/slots.ts'
export type { AttentionKind, AttentionRow } from './attention.ts'
export type { Translate, AttentionPanelProps } from './AttentionPanel.tsx'
export type { ToastBridgeProps } from './toast-bridge.tsx'
export type { SessionAttentionToastRemoteNamespace } from './typert.ts'
export type { ToastSendRequest, ToastSendResult } from '../types.ts'

/** Plugin config: a user-supplied character PNG (URL or data-URI) and the toast bridge. */
export interface Config {
  /** Character image URL or data-URI; undefined uses the procedural fallback. */
  characterImage?: string
  /**
   * Desktop toasts for sessions entering attention. Default `true`; requires
   * the host half's `sessionAttentionToast` service (Windows/WSL bridge).
   */
  toast?: boolean
}

/**
 * The minimal face this package needs from the client Remote service. Typed
 * locally so the browser half never imports the gateway package; the runtime
 * shape is the gateway's `ClientRemote` (`$mount` plus mounted namespaces).
 */
interface RemoteFace {
  $mount: (contribution: object) => Promise<() => unknown>
}

/** Services required: the slot registry, the sessions service, and the Remote mount. */
export const inject = ['slots', 'sessions', 'remote']

/**
 * Client plugin body: mount the toast Remote namespace, then contribute the
 * attention entries to the shell overlay. The open-session action and the
 * toast send action are built here from the runtime services so the
 * components never reach for ctx.
 * @param ctx - client root context.
 * @param config - plugin config (character image URL, toast bridge toggle).
 */
export async function apply(ctx: ClientContext, config: Config = {}): Promise<void> {
  const sessions = ctx.get('sessions')
  const injected = (): SessionAttentionInjected => ({
    openSession: (id) => {
      if (sessions !== undefined) sessions.open(id as never)
    },
  })

  // Mount the toast namespace before the overlay entries register, so the
  // bridge's first send always finds its methods. The mounted disposer joins
  // this fiber: stopping the plugin unmounts the namespace.
  const remote = ctx.get('remote') as RemoteFace | undefined
  let sendToast: (request: ToastSendRequest) => void = () => {}
  if (config.toast !== false && remote !== undefined && typeof remote.$mount === 'function') {
    const mounting = remote.$mount(TYPERT_REMOTE)
    // Read the mounted namespace through ctx.get, the inject-free optional
    // read: a mounted Remote namespace is a Service under
    // 'remote.sessionAttentionToast', and Cordis gated property access
    // (face.sessionAttentionToast) requires an inject declaration this
    // self-mounting plugin can never satisfy — it would deadlock on its own
    // startup. ctx.get resolves the same instance without the gate.
    const mounted = mounting.then(() =>
      ctx.get('remote.sessionAttentionToast') as SessionAttentionToastRemoteNamespace | undefined)
    ctx.effect(async () => {
      const disposer = await mounting
      return () => { void disposer() }
    }, 'session-attention.toastRemote')
    sendToast = (request) => {
      void mounted
        .then(namespace => namespace?.send(request))
        .catch(() => {})
    }
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-attention-3d',
    order: 80,
    inject: () => {
      const face = injected()
      return config.characterImage !== undefined
        ? { ...face, characterImage: config.characterImage }
        : face
    },
  }, AttentionPanel))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-attention-toast',
    order: 81,
    inject: (): ToastBridgeInjected => ({ sendToast }),
  }, ToastBridge))
}
