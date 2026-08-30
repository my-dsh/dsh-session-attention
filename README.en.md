# dsh-session-attention

English | [中文](README.md)

Session attention overlay plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A character peeks in from the top-right edge of the web GUI and plays a kind-specific dance animation while any session awaits the user's action (approval / plan review / question) or a background session's AI reply finished without being opened. The panel retreats when all sessions are handled.

![Session attention overlay: the top-right character panel showing one completed-reply attention row](docs/attention.png)

## Architecture

Two packages compose the full feature:

| Package | Name | Role |
|---|---|---|
| `client/` | `@deepseek-ai/dsh-client-ui-session-attention` | Pure browser plugin: one `shell.overlay` entry watching the session list and rendering a Canvas2D character animation |
| `bundle/` | `@deepseek-ai/dsh-session-attention` | Profile bundle: one `cordis.patch.yml` inserting the client panel row |

This plugin is **pure client-side** — it has no host half, no Service Definition, and no events. It reads the standard `useSessions` and `useSessionPendingInteraction` feeds already provided by the web surface.

### Data flow

```
Session state → useSessions hook (completed reminders)
                useSessionPendingInteraction hook (approval/plan-review/question)
                                        ↓
                    selectAttention(list, pending) — pure derivation
                                        ↓
                    AttentionPanel (shell.overlay entry)
                    ├── Character animation (Canvas2D)
                    ├── Attention rows (click to open session)
                    └── Browser tab title prefix (N)
```

### Character animation

The character lifecycle is a four-phase state machine: `peek → enter → dance → exit → peek`. Four dances map to the four attention kinds:

- **approval** — urgent fidget with quick hops and body shake
- **plan-review** — thinking sway with head tilt and sparkles
- **question** — confused wiggle with alternating head tilts and a "?" bubble
- **completed** — celebration with bounce-jumps, sway, spin, and sparkles

The animation engine applies per-frame `translate / rotate / scale / squash` transforms purely from elapsed time and lifecycle phase — deterministic (no `Math.random`) and testable in jsdom. The character can be a user-supplied PNG (via `characterImage` config) or a procedurally drawn fallback creature.

## Installation

```sh
dsh plugin --profile <name> add github:my-dsh/dsh-session-attention#dist
```

The panel renders only inside a web surface, so the target profile must already provide the client runtime, connection, and `shell.overlay` layout. Requires `pnpm` on `PATH`.

### Custom character image

```yaml
- id: ui-session-attention
  name: '@deepseek-ai/dsh-client-ui-session-attention'
  config:
    characterImage: 'data:image/png;base64,...'
```

When unset, the procedural fallback creature is used.

## Usage

The overlay needs no configuration: it starts on the next boot and watches the standard session feeds. A character peeks in from the top-right edge, jumps out to dance while attention is owed, and shows the session rows awaiting action. Click a row to open the session and consume the reminder. While attention is owed, the browser tab title is prefixed with `(N)` so the reminder survives a backgrounded tab.

## Source layout

```
dsh-session-attention/
├── client/
│   ├── src/
│   │   ├── index.ts               # Host loader entry (empty apply)
│   │   ├── invariant.ts           # Package invariant companion
│   │   ├── css-modules.d.ts       # CSS Modules type declarations
│   │   └── client/
│   │       ├── index.ts           # Browser plugin: shell.overlay registration
│   │       ├── attention.ts       # Pure attention-row selection logic
│   │       ├── AttentionPanel.tsx # Panel component (rows + canvas)
│   │       ├── character.ts       # Canvas2D animation engine (624 lines)
│   │       ├── character-lifecycle.ts  # peek→enter→dance→exit state machine
│   │       ├── contract/
│   │       │   └── slots.ts       # Inject face contract
│   │       └── ...
│   └── package.json
├── bundle/
│   ├── cordis.patch.yml           # 1-row insert: client panel
│   ├── src/
│   │   ├── index.ts               # Empty carrier
│   │   └── invariant.ts           # Bundle invariant companion
│   └── package.json
└── package.json                   # Root workspace
```

## Dependencies

This plugin depends on the following DSH packages (installed from the DSH monorepo):

- `@deepseek-ai/cordis` — Cordis plugin framework
- `@deepseek-ai/dsh-client-ui-layout` — `shell.overlay` slot owner
- `@deepseek-ai/dsh-client-ui-renderer` — Slot registry service
- `@deepseek-ai/dsh-client-ui-session` — `useSessions` and `useSessionPendingInteraction` hooks
- `@deepseek-ai/dsh-api-session-controller` — `SessionListState`, `SessionSummary`, `PendingInteractionStatus`
- `@deepseek-ai/dsh-session` — `SessionId` branded type

## License

MIT
