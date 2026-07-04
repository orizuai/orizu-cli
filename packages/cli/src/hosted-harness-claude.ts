/**
 * Claude-Agent-SDK driver for the AgentHarness seam (ALI-929 / P3.6, per ADR-005
 * §4a — the swappability proof).
 *
 * This is the SECOND `AgentHarness` implementation behind the same seam as the
 * OpenCode driver (`hosted-harness-opencode.ts`). It drives
 * `@anthropic-ai/claude-agent-sdk`'s `query()` loop — an IN-PROCESS agent loop,
 * with NO server process to spawn and no localhost SSE to parse — and normalizes
 * the SDK's message/tool stream into the SAME `HarnessEvent` vocabulary the
 * event bridge (`hosted-run-event-sink.ts`) already consumes. It carries ZERO
 * Claude-Agent-SDK types across the seam: everything below stays behind
 * `createClaudeAgentHarness`, exactly as the OpenCode SSE schema stays behind
 * `createOpenCodeHarness`.
 *
 * The founder's locked escape-hatch ("OpenInspect, but we can move to our own
 * harness whenever we want") is proven by this module existing and passing the
 * SAME session-cell invariants through the SAME sink — see
 * `test/cli/hosted-harness-swap.test.ts`.
 *
 * INJECTABLE LOADER: like the Daytona/Vercel SDK adapters, the SDK is imported
 * LAZILY through a NON-LITERAL specifier so the CLI/app build resolve without the
 * package, and a `loadModule` dep is injectable so tests exercise the
 * normalization against a fake `query()` with no real SDK and no model calls.
 *
 * ── query() → runPrompt() mapping ────────────────────────────────────────────
 * ONE `query()` call drives ONE `runPrompt()` to completion. The SDK's async
 * iterable yields `SDKMessage`s; we translate them:
 *   • system/init            → capture session_id; emit `ready` once.
 *   • assistant.message      → text blocks → `token` (keyed by the SDK message id
 *                              for coalescing); tool_use blocks → `tool_call`. The
 *                              per-turn `message.usage` the SDK ALWAYS populates is
 *                              deliberately NOT emitted as a `step_finish` (see
 *                              leak #3): the driver coalesces to ONE terminal
 *                              step_finish so both harnesses share one granularity.
 *   • user.message           → tool_result blocks → `tool_result` (paired to the
 *                              tool_use by callId, exactly once).
 *   • stream_event (partial) → text deltas are accumulated into the running token
 *                              snapshot for coalescing; consumed, not 1:1 mapped.
 *   • result/success         → final `step_finish` with cost+tokens, then
 *                              `execution_complete` (success, or aborted on stop).
 *   • result/error_*         → `error` (critical terminal).
 * The stream ALWAYS ends with exactly one terminal event.
 *
 * ── WHAT LEAKS THROUGH THE BOUNDARY (map-conservatively evidence) ─────────────
 * These SDK signals have NO clean `HarnessEvent` kind and are DROPPED here (not a
 * reason to widen the seam — this is the audit of the boundary's fit):
 *   1. `thinking` / `redacted_thinking` content blocks — the harness vocabulary
 *      has no reasoning kind (OpenCode's driver drops reasoning too), so extended
 *      thinking is not forwarded. Cost of surfacing it: a new `thinking` kind on
 *      the seam + a bridge mapping — a deliberate future decision, not done here.
 *   2. `system/compact_boundary` — context-compaction markers are dropped (the
 *      OpenCode driver handles `session.compacted` internally and forwards
 *      nothing either; parity, not a leak).
 *   3. Per-assistant-turn USAGE granularity — the real contract is that every
 *      `SDKAssistantMessage.message` is a `BetaMessage` whose `usage: BetaUsage`
 *      is ALWAYS populated (input/output token counts are non-optional), so the
 *      SDK reports usage on EACH assistant turn, not only at the terminal. The
 *      driver deliberately DOES NOT emit a `step_finish` per assistant turn: it
 *      coalesces to exactly ONE terminal `step_finish` at the `result` message,
 *      carrying `total_cost_usd` + aggregate `usage`. OpenCode emits one
 *      `step_finish` per `step-finish` part; for a one-tool task that is also a
 *      single terminal step, so the two streams are legitimately identical at the
 *      seam. This coalescing is itself a swappability win — the seam absorbs the
 *      raw per-turn/per-step granularity difference so downstream sees one
 *      normalized `agent_step_finish` from either harness. (Cost is only known at
 *      the terminal `result`; per-turn `usage` carries tokens but no cost, which
 *      is why folding to the terminal loses nothing the seam surfaces.)
 *   4. `result.num_turns` / `duration_ms` / `permission_denials` — folded into
 *      the terminal transition's shape (success/aborted/error), not surfaced as
 *      distinct events.
 *   5. Git author identity is plumbed via `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 *      ENV on the query options (the SDK has no first-class author param), where
 *      OpenCode takes it structurally. Same effect, different plumbing point.
 *      NOTE the `env` CONTRACT: the SDK's `env` REPLACES the subprocess
 *      environment entirely (it is NOT merged with `process.env`), so we spread
 *      `...process.env` FIRST — without it the `claude` subprocess would lose
 *      `PATH`/`HOME`/`ANTHROPIC_API_KEY` and die. G3 credential model: like the
 *      OpenCode path (which hands `opencode` the non-secret dummy key), the SDK
 *      client is given the same `anthropicDummyKey` as `ANTHROPIC_API_KEY`; the
 *      real key is injected by the sandbox firewall on egress to
 *      api.anthropic.com, so NO raw key ever enters the in-process client. See
 *      the G3/credentials axis in ali-929-harness-comparison.md.
 *   6. The resumable agent session id is assigned LAZILY by the SDK at
 *      `system/init` — it does not exist before the first `runPrompt`. So
 *      `start()` returns the RESUME id if given, else `''`; the real id first
 *      reaches the bridge via the `ready` event. OpenCode creates its session
 *      eagerly in `start()`. This is the one place the seam's "start returns the
 *      session id" shape fits OpenCode better than the SDK — the run still
 *      completes identically (the sink records the id from `ready`); see the
 *      comparison doc's swappability verdict.
 *   7. Provider-qualified model strings (e.g. `anthropic/claude-opus-4-8`) are
 *      reduced to the bare model id the SDK expects (leading `anthropic/` is
 *      stripped; other providers pass through unchanged and would be the SDK's to
 *      reject).
 */

import type {
  AgentHarness,
  HarnessEvent,
  HarnessPrompt,
  HarnessStartOptions,
  McpServerConfig,
} from './hosted-harness.js'

// -- Structural view of the @anthropic-ai/claude-agent-sdk surface we touch ----
// Kept LOCAL (not imported) so the seam type-checks and the app build resolves
// without the package present — same discipline as the Daytona/Vercel adapters.
// PIN CONTRACT: verified against @anthropic-ai/claude-agent-sdk@0.3.201 —
// `query({ prompt, options })` returns a `Query` (an `AsyncGenerator<SDKMessage>`
// exposing `interrupt()`); the union discriminates on `type` (+ `subtype` for
// `system`/`result`). packages/cli/package.json pins this version EXACTLY (no
// caret); re-verify the message-union shape before bumping.

/** An Anthropic content block as it appears inside an SDK assistant/user message
 *  (`message.content`). Kept structural — we read only the fields we map. */
interface SdkContentBlock {
  type: string
  // text block
  text?: string
  // tool_use block
  id?: string
  name?: string
  input?: unknown
  // tool_result block
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface SdkAnthropicMessage {
  id?: string
  role?: string
  content?: SdkContentBlock[] | string
  usage?: Record<string, unknown>
}

/** A raw Anthropic streaming event, forwarded by the SDK when partial messages
 *  are enabled (`type: 'stream_event'`). We read only the text-delta path. */
interface SdkStreamRawEvent {
  type?: string
  index?: number
  delta?: { type?: string; text?: string }
  content_block?: { type?: string }
  message?: { id?: string }
}

/** The SDK message union. Discriminated on `type` (+ `subtype` for system). */
interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  message?: SdkAnthropicMessage
  event?: SdkStreamRawEvent
  // result message fields
  is_error?: boolean
  total_cost_usd?: number
  usage?: Record<string, unknown>
  result?: string
}

interface SdkMcpServerConfig {
  type: string
  command?: string
  args?: readonly string[]
  url?: string
  env?: Record<string, string>
}

interface SdkQueryOptions {
  model?: string
  cwd?: string
  resume?: string
  abortController?: AbortController
  permissionMode?: string
  /** REQUIRED by the SDK whenever `permissionMode: 'bypassPermissions'` — a
   *  safety measure to make the bypass intentional. Verified against
   *  @anthropic-ai/claude-agent-sdk@0.3.201 Options.allowDangerouslySkipPermissions. */
  allowDangerouslySkipPermissions?: boolean
  includePartialMessages?: boolean
  mcpServers?: Record<string, SdkMcpServerConfig>
  /** The SDK's `env` REPLACES the subprocess environment entirely (it is NOT
   *  merged with `process.env`). Matches the real contract's
   *  `{ [k: string]: string | undefined }` so `...process.env` spreads cleanly. */
  env?: Record<string, string | undefined>
}

/** The object `query()` returns: an async iterable of messages plus `interrupt`. */
interface SdkQueryResult extends AsyncIterable<SdkMessage> {
  interrupt?: () => Promise<void>
}

export interface ClaudeAgentSdkModule {
  query: (args: { prompt: string; options: SdkQueryOptions }) => SdkQueryResult
}

// The package name lives in a variable so TypeScript treats the dynamic import as
// `any` (no static module resolution / ts2307 at app-build time) and no bundler
// traces it — this keeps the SDK genuinely optional, loaded only when the
// `claude-agent-sdk` harness is actually selected.
const CLAUDE_AGENT_SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk'

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  try {
    const specifier: string = CLAUDE_AGENT_SDK_SPECIFIER
    const mod = (await import(specifier)) as unknown as ClaudeAgentSdkModule
    if (!mod || typeof mod.query !== 'function') {
      throw new Error('module did not export a query() function')
    }
    return mod
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Claude Agent SDK unavailable (${detail}). Install it before the live run: \`bun install --cwd packages/cli\` (declares @anthropic-ai/claude-agent-sdk).`
    )
  }
}

export interface ClaudeAgentHarnessOptions {
  /** Test seam: inject a fake SDK so normalization runs with no real query/model. */
  loadModule?: () => Promise<ClaudeAgentSdkModule>
  /** Permission posture; default 'bypassPermissions' (the sandbox is the boundary,
   *  mirroring the OpenCode driver's allow-all config). */
  permissionMode?: string
  /**
   * Non-secret placeholder key handed to the in-process SDK client as
   * `ANTHROPIC_API_KEY` (G3). The sandbox firewall swaps in the real key on
   * egress to api.anthropic.com, so no raw key enters the client — the SAME
   * brokering the OpenCode path relies on. Threaded from the loop boot context;
   * never a real key. When absent, `ANTHROPIC_API_KEY` is inherited from
   * `process.env` as-is (still expected to be the dummy in the sandbox).
   */
  anthropicDummyKey?: string
}

// -- helpers -----------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Reduce a provider-qualified model ("anthropic/claude-opus-4-8") to the bare id
 *  the Agent SDK expects; other providers pass through for the SDK to judge. */
function toSdkModel(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model
}

/** Map the seam's structural MCP descriptors to the SDK's config record. */
function toSdkMcpServers(
  servers: readonly McpServerConfig[] | undefined
): Record<string, SdkMcpServerConfig> | undefined {
  if (!servers || servers.length === 0) return undefined
  const out: Record<string, SdkMcpServerConfig> = {}
  for (const s of servers) {
    out[s.name] = {
      type: s.transport ?? (s.url ? 'http' : 'stdio'),
      command: s.command,
      args: s.args,
      url: s.url,
      env: s.env,
    }
  }
  return out
}

/** Flatten an SDK message's content blocks (array or bare string) to blocks. */
function contentBlocks(message: SdkAnthropicMessage | undefined): SdkContentBlock[] {
  const content = message?.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

/** Coerce a tool_result block's `content` to a string output. */
function toolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const rec = asRecord(part)
        return typeof rec.text === 'string' ? rec.text : ''
      })
      .join('')
  }
  return ''
}

// -- The driver --------------------------------------------------------------

export function createClaudeAgentHarness(
  options: ClaudeAgentHarnessOptions = {}
): AgentHarness {
  const load = options.loadModule ?? loadClaudeAgentSdk
  const permissionMode = options.permissionMode ?? 'bypassPermissions'
  const anthropicDummyKey = options.anthropicDummyKey

  let sdk: ClaudeAgentSdkModule | null = null
  let startModel: string | undefined
  let startWorkspaceDir: string | undefined
  let startMcpServers: readonly McpServerConfig[] | undefined
  // The resumable session id: seeded from start()'s resume option, then updated
  // to whatever the SDK assigns at each system/init so subsequent prompts
  // continue the same conversation (parity with OpenCode session reuse).
  let currentSessionId: string | null = null
  let readyEmitted = false

  // Set true by the public stop(); makes the resulting terminal a cancellation.
  let stopRequested = false
  // The in-flight query's handles, so stop() can interrupt/abort it.
  let activeQuery: SdkQueryResult | null = null
  let activeAbort: AbortController | null = null

  async function ensureSdk(): Promise<ClaudeAgentSdkModule> {
    if (!sdk) sdk = await load()
    return sdk
  }

  return {
    name: 'claude-agent-sdk',

    async start(opts: HarnessStartOptions): Promise<{ agentSessionId: string }> {
      startModel = opts.model
      startWorkspaceDir = opts.workspaceDir
      startMcpServers = opts.mcpServers
      // Load eagerly so a missing SDK fails at start() (like OpenCode validating
      // its session), not mid-stream. The session id is assigned lazily by the
      // SDK at init — see leak #6 — so we can only echo a resume id here.
      await ensureSdk()
      currentSessionId = opts.resumeAgentSessionId ?? null
      return { agentSessionId: opts.resumeAgentSessionId ?? '' }
    },

    async *runPrompt(prompt: HarnessPrompt, signal: AbortSignal): AsyncIterable<HarnessEvent> {
      const mod = await ensureSdk()

      // Per-prompt state.
      stopRequested = false
      const abortController = new AbortController()
      activeAbort = abortController
      // Bridge the caller's signal into the SDK's abort controller.
      const onAbort = (): void => abortController.abort()
      if (signal.aborted) abortController.abort()
      else signal.addEventListener('abort', onAbort, { once: true })

      // Per-message accumulated text for coalesced token snapshots.
      const messageText = new Map<string, string>()
      // The id of the assistant message currently streaming (from the partial
      // `message_start` event), so text deltas coalesce under the SAME id the
      // final assistant snapshot uses — not a synthetic partial key.
      let partialMessageId: string | null = null
      // Tool calls already forwarded, so a re-observed block isn't double-emitted.
      const emittedToolCalls = new Set<string>()
      const emittedToolResults = new Set<string>()

      const author = prompt.author
      const queryOptions: SdkQueryOptions = {
        model: toSdkModel(startModel),
        cwd: startWorkspaceDir,
        resume: currentSessionId ?? undefined,
        abortController,
        permissionMode,
        // The SDK requires this be true whenever permissionMode is
        // 'bypassPermissions' (safety gate). Leave unset for any other mode.
        allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' ? true : undefined,
        includePartialMessages: true,
        mcpServers: toSdkMcpServers(startMcpServers),
        // `env` REPLACES the subprocess environment entirely — spread process.env
        // FIRST so PATH/HOME/ANTHROPIC_API_KEY survive; without it the subprocess
        // dies. G3: hand the SDK client the non-secret dummy key (the firewall
        // brokers the real key on egress). Git author identity plumbed here too
        // (leak #5) since the SDK has no first-class author param.
        env: {
          ...process.env,
          ...(anthropicDummyKey ? { ANTHROPIC_API_KEY: anthropicDummyKey } : {}),
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      }

      let q: SdkQueryResult
      try {
        q = mod.query({ prompt: prompt.content, options: queryOptions })
      } catch (error) {
        activeQuery = null
        activeAbort = null
        signal.removeEventListener('abort', onAbort)
        yield errorEvent(prompt.messageId, error)
        return
      }
      activeQuery = q

      let terminalYielded = false
      try {
        for await (const msg of q) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            if (typeof msg.session_id === 'string') currentSessionId = msg.session_id
            if (!readyEmitted) {
              readyEmitted = true
              yield {
                kind: 'ready',
                messageId: prompt.messageId,
                payload: { agentSessionId: currentSessionId ?? '' },
              }
            }
            continue
          }

          // compact_boundary and any other system subtype: no mapping (leak #2).
          if (msg.type === 'system') continue

          if (msg.type === 'stream_event') {
            const ev = msg.event ?? {}
            // Track the streaming message id so deltas coalesce under the same key
            // the assistant snapshot will use.
            if (ev.type === 'message_start' && typeof ev.message?.id === 'string') {
              partialMessageId = ev.message.id
            }
            // Accumulate text deltas into the running per-message snapshot so the
            // sink coalesces token growth (leak: partials consumed, not 1:1).
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const msgId =
                partialMessageId ?? (typeof msg.message?.id === 'string' ? msg.message.id : '_partial')
              const next = (messageText.get(msgId) ?? '') + (ev.delta.text ?? '')
              messageText.set(msgId, next)
              if (next) yield { kind: 'token', messageId: msgId, payload: { text: next } }
            }
            continue
          }

          if (msg.type === 'assistant') {
            const msgId = typeof msg.message?.id === 'string' ? msg.message.id : ''
            // Accumulate all text first so the coalesced token snapshot for the
            // turn is emitted BEFORE any tool_call — matching the OpenCode driver's
            // token-then-tool ordering (thinking/redacted_thinking dropped, leak #1).
            let combined = ''
            const toolUseBlocks: SdkContentBlock[] = []
            for (const block of contentBlocks(msg.message)) {
              if (block.type === 'text') {
                combined += typeof block.text === 'string' ? block.text : ''
              } else if (block.type === 'tool_use') {
                toolUseBlocks.push(block)
              }
            }
            // Emit the authoritative full-text snapshot for the turn (coalesces
            // with any partial snapshots the sink already buffered).
            if (combined && msgId) {
              const prev = messageText.get(msgId) ?? ''
              if (combined.length >= prev.length) {
                messageText.set(msgId, combined)
                yield { kind: 'token', messageId: msgId, payload: { text: combined } }
              }
            }
            for (const block of toolUseBlocks) {
              const callId = typeof block.id === 'string' ? block.id : ''
              if (!callId || emittedToolCalls.has(callId)) continue
              emittedToolCalls.add(callId)
              yield {
                kind: 'tool_call',
                messageId: msgId || prompt.messageId,
                payload: {
                  tool: typeof block.name === 'string' ? block.name : '',
                  args: asRecord(block.input),
                  callId,
                  status: 'running',
                },
              }
            }
            // NB: `msg.message.usage` (BetaUsage) is ALWAYS populated on real
            // assistant turns, but we deliberately do NOT emit a per-turn
            // step_finish — the driver coalesces to ONE terminal step_finish at
            // the `result` message so both harnesses normalize to the same
            // granularity at the seam (leak #3).
            continue
          }

          if (msg.type === 'user') {
            for (const block of contentBlocks(msg.message)) {
              if (block.type !== 'tool_result') continue
              const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
              if (!callId || emittedToolResults.has(callId)) continue
              emittedToolResults.add(callId)
              yield {
                kind: 'tool_result',
                messageId: prompt.messageId,
                payload: {
                  callId,
                  status: block.is_error === true ? 'error' : 'completed',
                  output: toolResultOutput(block.content),
                },
              }
            }
            continue
          }

          if (msg.type === 'result') {
            const success = msg.subtype === 'success' && msg.is_error !== true
            if (success) {
              // Final step_finish carries the total cost + usage (leak #3).
              yield {
                kind: 'step_finish',
                messageId: prompt.messageId,
                payload: { cost: msg.total_cost_usd ?? null, tokens: msg.usage ?? null, reason: 'result' },
              }
              terminalYielded = true
              yield {
                kind: 'execution_complete',
                messageId: prompt.messageId,
                critical: true,
                payload: stopRequested ? { success: false, aborted: true } : { success: true },
              }
              return
            }
            // error_max_turns / error_during_execution → critical error terminal.
            terminalYielded = true
            yield {
              kind: 'error',
              messageId: prompt.messageId,
              critical: true,
              payload: { error: describeResultError(msg) },
            }
            return
          }
          // Unknown message type: no mapping — skip (documented boundary).
        }

        // Stream ended without a result message (server/loop closed early).
        if (!terminalYielded) {
          if (stopRequested || signal.aborted) {
            yield {
              kind: 'execution_complete',
              messageId: prompt.messageId,
              critical: true,
              payload: { success: false, aborted: true },
            }
          } else {
            yield {
              kind: 'execution_complete',
              messageId: prompt.messageId,
              critical: true,
              payload: { success: true },
            }
          }
        }
      } catch (error) {
        // An abort (caller signal or stop()) resolves as a cancellation, never a
        // plain failure (parity with the OpenCode driver's P2-2 rule).
        if (stopRequested || signal.aborted || isAbortError(error)) {
          if (!terminalYielded) {
            yield {
              kind: 'execution_complete',
              messageId: prompt.messageId,
              critical: true,
              payload: { success: false, aborted: true },
            }
          }
        } else if (!terminalYielded) {
          yield errorEvent(prompt.messageId, error)
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        activeQuery = null
        activeAbort = null
      }
    },

    async stop(): Promise<void> {
      // Cancellation is via `abortController.abort()` — that works in ALL modes
      // and is the REAL mechanism here. `query().interrupt()` is a control request
      // the SDK only honors in streaming-INPUT mode; this driver uses string-prompt
      // mode, so interrupt() is a no-op harmless best-effort at most. We call it
      // first (in case a future streaming-input path is added) but the abort below
      // is what actually cancels the in-flight query.
      stopRequested = true
      const q = activeQuery
      if (q && typeof q.interrupt === 'function') {
        try {
          await q.interrupt()
        } catch {
          // best-effort — the abort below is the real cancellation
        }
      }
      try {
        activeAbort?.abort()
      } catch {
        // controller already aborted / gone
      }
    },

    async shutdown(): Promise<void> {
      currentSessionId = null
      readyEmitted = false
      stopRequested = false
      activeQuery = null
      activeAbort = null
      sdk = null
    },
  }
}

/** A terminal `error` HarnessEvent from a thrown/rejected query. */
function errorEvent(messageId: string, error: unknown): HarnessEvent {
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'error', messageId, critical: true, payload: { error: message } }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'DOMException')
}

/** Human-readable reason for a non-success result message. */
function describeResultError(msg: SdkMessage): string {
  if (msg.subtype === 'error_max_turns') return 'agent stopped: max turns reached'
  if (msg.subtype === 'error_max_budget_usd') return 'agent stopped: max budget reached'
  if (msg.subtype === 'error_during_execution') return 'agent error during execution'
  if (typeof msg.result === 'string' && msg.result) return msg.result
  return 'agent error'
}
