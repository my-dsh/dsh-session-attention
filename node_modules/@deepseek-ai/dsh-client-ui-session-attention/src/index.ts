/**
 * Host half of the session-attention plugin: the `sessionAttentionToast`
 * Typert Remote service. The browser bridge (this package's client half)
 * derives attention rows from the standard `useSessions` feed — the exact
 * rules the overlay panel renders — and calls
 * {@link SessionAttentionToastService.send} through the Typert gateway when a
 * session enters attention. This half renders the request as one native
 * Windows toast by driving Windows PowerShell through WSL interop:
 *
 * - the toast XML is XML-escaped here, base64-encoded, and decoded inside the
 *   script (`[Text.Encoding]::UTF8`), so non-ASCII copy never crosses the
 *   WSL console codepage;
 * - a custom AppUserModelID (`DSH.Notify`, display name "DeepSeek Harness")
 *   is registered under HKCU on first use — an unregistered AUMID makes the
 *   WinRT toast API succeed while Windows silently drops the notification;
 * - `suppressWhenFocused` requests gate on the foreground window title
 *   (user32 `GetForegroundWindow`), matching the harness-focused state.
 *
 * Export discipline: the default export is the Service class (the loader
 * instantiates class plugins with `new Class(ctx, config)`).
 * @module @deepseek-ai/dsh-client-ui-session-attention
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ToastSendRequest, ToastSendResult } from './types.ts'

export type { ToastSendRequest, ToastSendResult } from './types.ts'

/** Registered toast AppUserModelID; display name "DeepSeek Harness". */
const AUMID = 'DSH.Notify'

/** Foreground-window title marker for the focus gate. */
const FOCUS_MARKER = 'DSH'

/** Windows-side PowerShell candidates; the WSL interop path first. */
const POWERSHELL_CANDIDATES: readonly [string, string] = [
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  'powershell.exe',
]

/** Hard per-spawn deadline; the caller owns timeouts, escalation included. */
const SPAWN_TIMEOUT_MS = 15_000

/** Escape one string for embedding inside the toast XML text rows. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Build the ToastGeneric XML for one request. */
function toastXml(request: ToastSendRequest): string {
  const rows = [request.title, request.body, request.detail]
    .filter((row): row is string => typeof row === 'string' && row.length > 0)
  const text = rows.map(row => `<text>${escapeXml(row)}</text>`).join('')
  return '<toast duration="short"><visual><binding template="ToastGeneric">'
    + text
    + '</binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'
}

/** HKCU AppUserModelID registration; idempotent, no elevation required. */
function registrationScript(): string {
  return `$id='${AUMID}';$r='HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\'+$id;`
    + 'if(-not(Test-Path $r)){New-Item -Path $r -Force|Out-Null};'
    + 'Set-ItemProperty -Path $r -Name \'DisplayName\' -Value \'DeepSeek Harness\' -Force'
}

/**
 * One toast render. The whole XML crosses as base64 UTF-8 inside the script;
 * the script itself is pure ASCII so the WSL console codepage can never mangle
 * copy. It crosses via `-EncodedCommand` (UTF-16LE base64): WSL interop
 * swallows a piped-stdin script under `-Command -` — the process exits 0
 * without executing the script — so the stdin transport is unusable here.
 */
function toastScript(request: ToastSendRequest): string {
  const xmlBase64 = Buffer.from(toastXml(request), 'utf8').toString('base64')
  const gate = request.suppressWhenFocused === true
    ? 'Add-Type -Namespace DSHN -Name U32 -MemberDefinition \'[DllImport("user32.dll")]'
      + ' public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)]'
      + ' public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);\''
      + ' -ErrorAction SilentlyContinue;'
      + '$h=[DSHN.U32]::GetForegroundWindow();'
      + '$sb=New-Object System.Text.StringBuilder 512;'
      + '[void][DSHN.U32]::GetWindowText($h,$sb,512);'
      + `if($sb.ToString()-like '*${FOCUS_MARKER}*'){exit 0};`
    : ''
  return '$ErrorActionPreference=\'Stop\';try{'
    + gate
    + '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];'
    + '[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime];'
    + '$d=[Windows.Data.Xml.Dom.XmlDocument]::new();'
    + `$d.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlBase64}')));`
    + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}')`
    + '.Show([Windows.UI.Notifications.ToastNotification]::new($d));'
    + 'Write-Output \'TOAST_OK\'}catch{Write-Output (\'TOAST_ERR:\'+$_.Exception.Message)}'
}

/** Resolve the PowerShell executable once: WSL interop path, then PATH fallback. */
function resolvePowershell(): string {
  for (const candidate of POWERSHELL_CANDIDATES) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
  }
  return POWERSHELL_CANDIDATES[1]
}

/** One bridge process outcome; stderr joins stdout so errors stay diagnosable. */
interface BridgeOutcome {
  ok: boolean
  text: string
}

/**
 * The `sessionAttentionToast` Remote service. One bridge process runs at a
 * time; a request arriving mid-flight coalesces into the queued slot (last
 * wins) and replays after the in-flight process settles, so a burst of
 * attention edges cannot stack PowerShell processes.
 */
export class SessionAttentionToastService extends TypertRemoteService {
  static inject: readonly string[] = []

  private powershell: string | undefined
  private registered = false
  private inFlight = false
  private queued: ToastSendRequest | null = null

  /**
   * @param ctx - host context; no other service is required.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionAttentionToast')
  }

  protected async [Service.init](): Promise<void> {
    this.powershell = resolvePowershell()
  }

  /**
   * Render one toast. Coalesced requests report `delivered: false`.
   * @param request - the browser bridge's toast request.
   * @returns whether Windows accepted the toast.
   */
  @Remote('send')
  async send(request: ToastSendRequest): Promise<ToastSendResult> {
    if (this.inFlight) {
      this.queued = request
      return { delivered: false }
    }
    this.inFlight = true
    try {
      const exe = this.powershell ?? resolvePowershell()
      if (!this.registered) {
        this.registered = true
        await this.run(exe, registrationScript())
      }
      const outcome = await this.run(exe, toastScript(request))
      return { delivered: outcome.ok && outcome.text.includes('TOAST_OK') }
    } finally {
      this.inFlight = false
      const next = this.queued
      this.queued = null
      if (next !== null) void this.send(next).catch(() => {})
    }
  }

  /**
   * Run one ASCII script through the bridge; never rejects. The script
   * crosses via `-EncodedCommand` (UTF-16LE base64): WSL interop swallows a
   * piped-stdin script under `-Command -` — the process exits 0 without
   * executing the script — so the stdin transport is unusable here.
   */
  private run(exe: string, script: string): Promise<BridgeOutcome> {
    return new Promise((resolve) => {
      let text = ''
      let child: ReturnType<typeof spawn>
      try {
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
          cwd: tmpdir(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch {
        resolve({ ok: false, text: 'bridge-spawn-failed' })
        return
      }
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok, text })
      }
      const timer = setTimeout(() => {
        text += '\nbridge-timeout'
        child.kill()
      }, SPAWN_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.on('error', () => finish(false))
      child.on('close', code => finish(code === 0))
    })
  }
}

export default SessionAttentionToastService
