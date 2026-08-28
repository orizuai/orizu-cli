import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  read as readFileDescriptor,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const CHILD_OUTPUT_PREFETCH_MAX_BYTES = 64 * 1024
const CHILD_OUTPUT_READ_BUFFER_BYTES = 16 * 1024
const EMPTY_FIFO_INITIAL_RETRY_MS = 4
const EMPTY_FIFO_MAX_RETRY_MS = 64
const FORWARDING_FAILURE_TERMINATION_TIMEOUT_MS = 250, LIVE_OUTPUT_STALL_TIMEOUT_MS = 1_500
const LIVE_OUTPUT_RELAY_SCRIPT = [
  "const { writeSync } = require('node:fs')",
  'process.stdout._handle?.setBlocking(true)',
  'let buffered = Buffer.alloc(0)',
  'process.stdin.on(\'data\', chunk => {',
  '  buffered = Buffer.concat([buffered, chunk])',
  '  while (buffered.length >= 4) {',
  '    const length = buffered.readUInt32BE(0)',
  '    if (buffered.length < length + 4) return',
  '    const payload = buffered.subarray(4, length + 4)',
  '    buffered = buffered.subarray(length + 4)',
  '    for (let offset = 0; offset < payload.length; )',
  '      offset += writeSync(1, payload, offset, payload.length - offset)',
  "    writeSync(3, '1')",
  '  }',
  '})',
  "writeSync(3, 'R')",
].join('\n')

interface LiveOutputRelay {
  child: ReturnType<typeof spawn>
  input: Writable
  acknowledgements: Readable
  ready: Promise<void>
}

class FileDescriptorSource extends Readable {
  private descriptor: number | undefined
  private readonly readBuffer = Buffer.allocUnsafe(CHILD_OUTPUT_READ_BUFFER_BYTES)
  private emptyRetryMilliseconds = EMPTY_FIFO_INITIAL_RETRY_MS
  private isReadPending = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pendingDestroy: {
    error: Error | null
    callback: (error?: Error | null) => void
  } | undefined

  constructor(descriptor: number) {
    super({ highWaterMark: CHILD_OUTPUT_PREFETCH_MAX_BYTES })
    this.descriptor = descriptor
  }

  override _read(): void {
    if (this.isReadPending || this.retryTimer || this.descriptor === undefined) return
    this.isReadPending = true
    readFileDescriptor(
      this.descriptor,
      this.readBuffer,
      0,
      this.readBuffer.byteLength,
      null,
      (error, bytesRead) => {
      this.isReadPending = false
      if (this.pendingDestroy) {
        this.finishDestroy()
        return
      }
      if (error) {
        if (error.code === 'EINTR') {
          this._read()
          return
        }
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code ?? '')) {
          const delay = this.emptyRetryMilliseconds
          this.emptyRetryMilliseconds = Math.min(
            EMPTY_FIFO_MAX_RETRY_MS,
            this.emptyRetryMilliseconds * 2
          )
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined
            this._read()
          }, delay)
          return
        }
        this.destroy(error)
        return
      }
      if (bytesRead === 0) {
        this.push(null)
        return
      }
      this.emptyRetryMilliseconds = EMPTY_FIFO_INITIAL_RETRY_MS
      this.push(Buffer.from(this.readBuffer.subarray(0, bytesRead)))
    })
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.pendingDestroy = { error, callback }
    if (!this.isReadPending) this.finishDestroy()
  }

  private finishDestroy(): void {
    const pendingDestroy = this.pendingDestroy
    if (!pendingDestroy) return
    this.pendingDestroy = undefined
    const descriptor = this.descriptor
    this.descriptor = undefined
    try {
      if (descriptor !== undefined) closeSync(descriptor)
      pendingDestroy.callback(pendingDestroy.error)
    } catch (error) {
      pendingDestroy.callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

class FileDescriptorSink extends Writable {
  private readonly activeWriteCancellations = new Set<() => void>()
  private isLiveOutputAvailable = true
  private relay: LiveOutputRelay | undefined

  constructor(private readonly descriptor: number) {
    super({ highWaterMark: 16 * 1024 })
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.isLiveOutputAvailable) {
      callback()
      return
    }
    let relay: LiveOutputRelay | undefined
    let hasSettled = false
    const settle = (error?: Error | null): void => {
      if (hasSettled) return
      hasSettled = true
      if (error) this.isLiveOutputAvailable = false
      this.activeWriteCancellations.delete(cancel)
      relay?.acknowledgements.off('data', acknowledge)
      relay?.child.off('exit', relayExited)
      callback(error)
    }
    const acknowledge = (): void => settle()
    const relayExited = (): void => settle(new Error('live output relay exited before write acknowledgement'))
    const cancel = (): void => settle()
    this.activeWriteCancellations.add(cancel)
    try { relay = this.relayProcess() } catch (error) { settle(errorFromUnknown(error)); return }
    void relay.ready.then(() => {
      if (hasSettled) return
      relay!.acknowledgements.once('data', acknowledge)
      relay!.child.once('exit', relayExited)
      const frame = Buffer.allocUnsafe(chunk.byteLength + 4)
      frame.writeUInt32BE(chunk.byteLength)
      chunk.copy(frame, 4)
      relay!.input.write(frame, error => { if (error) settle(error) })
    }).catch(error => settle(errorFromUnknown(error)))
  }

  async prepare(): Promise<void> {
    if (!this.isLiveOutputAvailable) return
    await this.relayProcess().ready
  }

  cancelPendingWrites(): void {
    this.isLiveOutputAvailable = false
    const relay = this.relay
    this.relay = undefined
    relay?.input.destroy()
    relay?.child.kill('SIGKILL')
    for (const cancel of [...this.activeWriteCancellations]) cancel()
  }

  private relayProcess(): LiveOutputRelay {
    if (this.relay) return this.relay
    const child = spawn('node', ['-e', LIVE_OUTPUT_RELAY_SCRIPT], {
      stdio: ['pipe', this.descriptor, 'ignore', 'pipe'],
    })
    const input = child.stdin as Writable & { unref?: () => void }
    const acknowledgements = child.stdio[3] as Readable & { unref?: () => void }
    if (!input || !acknowledgements) throw new Error('live output relay has no control pipes')
    child.on('error', () => {})
    input.on('error', () => {})
    acknowledgements.on('error', () => {})
    const ready = new Promise<void>((resolve, reject) => {
      acknowledgements.once('data', chunk => {
        if ((chunk as Buffer).includes('R'.charCodeAt(0))) resolve()
        else reject(new Error('live output relay sent an invalid readiness acknowledgement'))
      })
      child.once('exit', () => reject(new Error('live output relay exited before readiness')))
      child.once('error', reject)
    })
    void ready.catch(() => {})
    child.unref()
    void ready.then(() => {
      input.unref?.()
      acknowledgements.unref?.()
    }, () => {})
    const relay = { child, input, acknowledgements, ready }
    child.once('exit', () => {
      if (this.relay?.child !== child) return
      this.relay = undefined
    })
    this.relay = relay
    return relay
  }
}

export const childOutputSinks = {
  stdout: new FileDescriptorSink(1),
  stderr: new FileDescriptorSink(2),
}

export interface PipedChild {
  stdout: Readable
  stderr: Readable
  exited: Promise<number | null>
  signalCode: NodeJS.Signals | null
  kill(signal?: number | NodeJS.Signals): void
}

const POST_LEADER_CAPTURE_DRAIN_TIMEOUT_MS = 250

interface OutputFifo {
  source: Readable
  writeDescriptor: number
}

function closeDescriptor(descriptor: number | undefined): void {
  if (descriptor === undefined) return
  try {
    closeSync(descriptor)
  } catch {
    // Best-effort cleanup after another operation has already failed.
  }
}

function createOutputFifo(name: string): OutputFifo {
  const root = mkdtempSync(join(tmpdir(), 'orizu-child-output-'))
  const fifoPath = join(root, name)
  let anchorDescriptor: number | undefined
  let readDescriptor: number | undefined
  let writeDescriptor: number | undefined
  try {
    const creation = spawnSync('mkfifo', [fifoPath], { stdio: 'ignore' })
    if (creation.error) throw creation.error
    if (creation.status !== 0) {
      throw new Error(`mkfifo exited with status ${creation.status ?? 'unknown'}`)
    }

    // The temporary read/write anchor prevents either open from waiting for
    // its peer. The child inherits the blocking write end; the parent polls a
    // nonblocking read end so descendant-held descriptors remain cancellable.
    anchorDescriptor = openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK)
    readDescriptor = openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK)
    writeDescriptor = openSync(fifoPath, constants.O_WRONLY)
    closeDescriptor(anchorDescriptor)
    anchorDescriptor = undefined

    const source = new FileDescriptorSource(readDescriptor)
    readDescriptor = undefined
    rmSync(root, { force: true, recursive: true })
    return { source, writeDescriptor }
  } catch (error) {
    closeDescriptor(writeDescriptor)
    closeDescriptor(readDescriptor)
    closeDescriptor(anchorDescriptor)
    rmSync(root, { force: true, recursive: true })
    throw error
  }
}

export async function spawnPipedChild(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<PipedChild> {
  const stdout = createOutputFifo('stdout')
  let stderr: OutputFifo
  try {
    stderr = createOutputFifo('stderr')
  } catch (error) {
    stdout.source.destroy()
    closeDescriptor(stdout.writeDescriptor)
    throw error
  }

  let child: ReturnType<typeof spawn>
  try {
    // Begin the bounded parent-side drain before an immediate child crash can
    // strand bytes in the child's userland stdout/stderr buffers.
    stdout.source.read(0)
    stderr.source.read(0)
    child = spawn(command, args, {
      env: environment,
      stdio: ['inherit', stdout.writeDescriptor, stderr.writeDescriptor],
    })
  } catch (error) {
    stdout.source.destroy()
    stderr.source.destroy()
    throw error
  } finally {
    closeDescriptor(stdout.writeDescriptor)
    closeDescriptor(stderr.writeDescriptor)
  }
  // `close` also waits for descendant-held stdio descriptors. Observe the
  // leader's exit so completePipedChild can enforce its bounded EOF grace.
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } catch (error) {
    stdout.source.destroy()
    stderr.source.destroy()
    throw error
  }
  return {
    stdout: stdout.source,
    stderr: stderr.source,
    exited,
    get signalCode() { return child.signalCode },
    kill: signal => { child.kill(signal) },
  }
}

interface LiveSinkState {
  hasFailed: boolean
}

const liveSinkStates = new WeakMap<Writable, LiveSinkState>()

function liveSinkState(destination: Writable): LiveSinkState {
  const existing = liveSinkStates.get(destination)
  if (existing) return existing
  const state = { hasFailed: false }
  destination.on('error', () => { state.hasFailed = true })
  liveSinkStates.set(destination, state)
  return state
}

async function writeLiveOutput(
  destination: Writable,
  state: LiveSinkState,
  text: string,
): Promise<void> {
  if (state.hasFailed) return
  await new Promise<void>(resolve => {
    try {
      destination.write(text, error => {
        if (error) state.hasFailed = true
        resolve()
      })
    } catch {
      state.hasFailed = true
      resolve()
    }
  })
}

export async function writeChildStderr(text: string): Promise<void> {
  const sink = childOutputSinks.stderr
  let timer: ReturnType<typeof setTimeout> | undefined
  const didForward = await Promise.race([
    writeLiveOutput(sink, liveSinkState(sink), `${text}\n`).then(() => true),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), LIVE_OUTPUT_STALL_TIMEOUT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (!didForward) sink.cancelPendingWrites()
}

export interface ChildOutputForwarding {
  completed: Promise<void>
  failure: Promise<Error>
  failureReason(): Error | undefined
  expectSourceClose(): void
  stopLiveOutput(): void
}

export interface ChildOutputCapture {
  stdout(chunk: string): void
  stderr(chunk: string): void
}

function errorFromUnknown(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

async function waitForChildExit(
  child: PipedChild,
  timeoutMilliseconds: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const didExit = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMilliseconds)
    }),
  ])
  if (timer) clearTimeout(timer)
  return didExit
}

async function terminateAfterForwardingFailure(
  child: PipedChild,
  forwarding: readonly ChildOutputForwarding[],
  captureDrain: Promise<PromiseSettledResult<void>[]>,
  error: Error
): Promise<never> {
  child.kill('SIGTERM')
  for (const stream of forwarding) stream.stopLiveOutput()
  child.stdout.destroy()
  child.stderr.destroy()
  await captureDrain
  if (!await waitForChildExit(child, FORWARDING_FAILURE_TERMINATION_TIMEOUT_MS)) {
    child.kill('SIGKILL')
    await waitForChildExit(child, FORWARDING_FAILURE_TERMINATION_TIMEOUT_MS)
  }
  throw error
}

export async function completePipedChild(
  child: PipedChild,
  forwarding: readonly ChildOutputForwarding[],
): Promise<number | null> {
  const captureDrain = Promise.allSettled(forwarding.map(stream => stream.completed))
  const firstFailure = Promise.race(forwarding.map(stream => stream.failure))
  const firstOutcome = await Promise.race([
    child.exited.then(status => ({ kind: 'exit' as const, status })),
    firstFailure.then(error => ({ kind: 'failure' as const, error })),
  ])
  if (firstOutcome.kind === 'failure') {
    return terminateAfterForwardingFailure(child, forwarding, captureDrain, firstOutcome.error)
  }
  const status = firstOutcome.status
  const waitForCaptureDrain = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const didDrain = await Promise.race([
      captureDrain.then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), POST_LEADER_CAPTURE_DRAIN_TIMEOUT_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    return didDrain
  }
  const throwIfCaptureFailed = async (): Promise<void> => {
    await captureDrain
    const failure = forwarding.map(stream => stream.failureReason()).find(Boolean)
    if (failure) throw failure
  }

  // Preserve ordinary live forwarding when EOF is already on its way. If a
  // blocked sink or descendant-held descriptor prevents that bounded drain,
  // switch to capture-only before enforcing the same bounded EOF grace.
  if (await waitForCaptureDrain()) {
    await throwIfCaptureFailed()
    return status
  }
  for (const stream of forwarding) stream.stopLiveOutput()
  if (await waitForCaptureDrain()) {
    await throwIfCaptureFailed()
    return status
  }
  for (const stream of forwarding) stream.expectSourceClose()
  child.stdout.destroy()
  child.stderr.destroy()
  await throwIfCaptureFailed()
  return status
}

export async function runPipedChild(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  onSpawn: () => Promise<void>,
  capture: ChildOutputCapture,
  observeChild?: (child: PipedChild) => void,
): Promise<{ status: number | null; error?: Error }> {
  await Promise.all([childOutputSinks.stdout.prepare(), childOutputSinks.stderr.prepare()])
  const child = await spawnPipedChild(command, args, environment)
  observeChild?.(child)
  const forwarding = [
    teeChildOutput(child.stdout, childOutputSinks.stdout, capture.stdout),
    teeChildOutput(child.stderr, childOutputSinks.stderr, capture.stderr),
  ]
  const completion = completePipedChild(child, forwarding)
  const firstForwardingFailure = Promise.race(
    forwarding.map(stream => stream.failure)
  ).then(error => { throw error })
  try {
    await Promise.race([onSpawn(), firstForwardingFailure])
    const exitCode = await completion
    return { status: child.signalCode ? null : exitCode }
  } catch (cause) {
    child.kill('SIGTERM')
    await completion.catch(() => undefined)
    throw cause
  }
}

/**
 * Forward a child stream live while retaining a bounded caller-owned copy.
 * Transient sink slowness pushes back; a stall degrades safely to capture-only.
 */
export function teeChildOutput(
  source: Readable,
  destination: Writable,
  capture: (chunk: string) => void,
): ChildOutputForwarding {
  let isLiveOutputEnabled = true
  let isSourceCloseExpected = false
  let unexpectedFailure: Error | undefined
  let remainingLiveOutputWaitMilliseconds = LIVE_OUTPUT_STALL_TIMEOUT_MS
  let liveOutputWaitFinishedAt = performance.now()
  let resolveLiveOutputStopped: () => void = () => {}
  const liveOutputStopped = new Promise<void>(resolve => { resolveLiveOutputStopped = resolve })
  const stopLiveOutput = (): void => {
    if (!isLiveOutputEnabled) return
    isLiveOutputEnabled = false
    if (destination instanceof FileDescriptorSink) destination.cancelPendingWrites()
    resolveLiveOutputStopped()
  }
  const sinkState = liveSinkState(destination)
  const forward = async (text: string): Promise<void> => {
    capture(text)
    if (!isLiveOutputEnabled) return
    const waitStartedAt = performance.now()
    remainingLiveOutputWaitMilliseconds = Math.min(
      LIVE_OUTPUT_STALL_TIMEOUT_MS,
      remainingLiveOutputWaitMilliseconds + waitStartedAt - liveOutputWaitFinishedAt
    )
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const wasForwarded = await Promise.race([
      writeLiveOutput(destination, sinkState, text).then(() => true),
      liveOutputStopped.then(() => false),
      new Promise<false>(resolve => {
        stallTimer = setTimeout(() => resolve(false), remainingLiveOutputWaitMilliseconds)
      }),
    ])
    if (stallTimer) clearTimeout(stallTimer)
    liveOutputWaitFinishedAt = performance.now()
    remainingLiveOutputWaitMilliseconds -= liveOutputWaitFinishedAt - waitStartedAt
    if (!wasForwarded || remainingLiveOutputWaitMilliseconds <= 0) stopLiveOutput()
  }
  const completed = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of source) {
      const text = decoder.decode(chunk as Uint8Array, { stream: true })
      if (text) await forward(text)
    }
    const remainder = decoder.decode()
    if (remainder) await forward(remainder)
  })()
  let resolveFailure: (error: Error) => void = () => {}
  const failure = new Promise<Error>(resolve => { resolveFailure = resolve })
  void completed.catch(cause => {
    if (isSourceCloseExpected) return
    unexpectedFailure = errorFromUnknown(cause)
    resolveFailure(unexpectedFailure)
  })
  return {
    completed,
    failure,
    failureReason: () => unexpectedFailure,
    expectSourceClose: () => { isSourceCloseExpected = true },
    stopLiveOutput,
  }
}
