/**
 * Hand-written consumer Remote contribution for the `sessionAttentionToast`
 * namespace. The Typert gateway resolves Host endpoints in source mode (it
 * reads the live Service's `@Remote` markers through `typertRemote`), so no
 * generated FaceModel artifacts exist or are needed; this module only carries
 * the consumer-side strict descriptors the Client gateway mandates at mount.
 * It mirrors the shape of a generated `typert.remote-client.js` module, with
 * one deliberate divergence: the boundary codecs are self-contained
 * validators instead of zod schemas, keeping the browser bundle free of a
 * schema runtime for one string-valued method.
 *
 * The `TypertRemoteNamespaceMap` merge is what types `remote.sessionAttentionToast`
 * for every consumer program that includes this module's types.
 * @module @deepseek-ai/dsh-client-ui-session-attention/typert
 */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ToastSendRequest, ToastSendResult } from '../types.ts'

/** Type face of the mounted `sessionAttentionToast` Remote namespace. */
export interface SessionAttentionToastRemoteNamespace {
  send: (request: ToastSendRequest) => Promise<RemoteResult<ToastSendResult>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$73657373696f6e417474656e74696f6e546f617374 {
    send: (request: ToastSendRequest) => Promise<RemoteResult<ToastSendResult>>
  }
  interface TypertRemoteMap {
    'sessionAttentionToast/send': (request: ToastSendRequest) => Promise<RemoteResult<ToastSendResult>>
  }
  interface TypertRemoteNamespaceMap {
    sessionAttentionToast: TypertRemoteNamespace$73657373696f6e417474656e74696f6e546f617374
  }
}

/** Strict boundary validator for one toast request (throws on shape drift). */
function toastRequestSchema(): { parse(value: unknown): ToastSendRequest } {
  return {
    parse(value: unknown): ToastSendRequest {
      if (typeof value !== 'object' || value === null) {
        throw new Error('toast request must be an object')
      }
      const raw = value as Record<string, unknown>
      if (typeof raw.title !== 'string' || raw.title.length === 0
        || typeof raw.body !== 'string' || raw.body.length === 0) {
        throw new Error('toast request requires non-empty string title and body')
      }
      return {
        title: raw.title,
        body: raw.body,
        ...(typeof raw.detail === 'string' && raw.detail.length > 0 ? { detail: raw.detail } : {}),
        ...(raw.suppressWhenFocused === true ? { suppressWhenFocused: true } : {}),
      }
    },
  }
}

/** Strict boundary validator for one toast outcome. */
function toastResultSchema(): { parse(value: unknown): ToastSendResult } {
  return {
    parse(value: unknown): ToastSendResult {
      if (typeof value !== 'object' || value === null) {
        throw new Error('toast result must be an object')
      }
      return { delivered: (value as { delivered?: unknown }).delivered === true }
    },
  }
}

/** The consumer contribution the client half mounts into `ctx.remote`. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-client-ui-session-attention',
  descriptors: [
    {
      id: '@deepseek-ai/dsh-client-ui-session-attention#sessionAttentionToast/send',
      service: 'sessionAttentionToast',
      namespace: 'sessionAttentionToast',
      method: 'send',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-client-ui-session-attention/types#ToastSendRequest',
            schema: toastRequestSchema(),
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-client-ui-session-attention/types#ToastSendResult',
        schema: toastResultSchema(),
      },
    },
  ],
}

export default TYPERT_REMOTE
