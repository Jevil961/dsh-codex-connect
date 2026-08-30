/** Opt-in, same-account recovery for an exhausted OpenAI Codex quota window. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { OpenAICodexRateLimitWindow, OpenAICodexUsage } from './usage.ts'
import { OPENAI_CODEX_PROVIDER, type OpenAICodexCredentialStore } from './store.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexProxyManager } from './provider-proxy.ts'

/** Server window duration used by the ChatGPT Codex five-hour bucket. */
export const OPENAI_CODEX_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60
/** Server window duration used by the ChatGPT Codex weekly bucket. */
export const OPENAI_CODEX_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60
/** Small safety margin so the server has crossed the reset boundary. */
export const OPENAI_CODEX_QUOTA_RESET_SKEW_MS = 2_000
/** Keep long waits cancellable and avoid platform timer overflow. */
export const OPENAI_CODEX_QUOTA_WAIT_CHUNK_MS = 60_000
/** Do not loop forever when a usage endpoint keeps returning a stale reset time. */
export const OPENAI_CODEX_QUOTA_MAX_STALE_RESETS = 2

const SPARK_MODEL = 'gpt-5.3-codex-spark'
const SPARK_QUOTA_ID = 'codex_bengalfox'
const STANDARD_QUOTA_ID = 'codex'

/** Recovery result after inspecting the provider's current quota projection. */
export type OpenAICodexQuotaDecision =
  | { readonly kind: 'wait-five-hour'; readonly resetAt: number }
  | { readonly kind: 'weekly-exhausted'; readonly resetAt?: number }
  | { readonly kind: 'available' }
  | { readonly kind: 'unknown' }

/** Payload shape of the agent request-error waterfall. */
export interface OpenAICodexRequestErrorPayload {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmFailure
  readonly retryPolicy: ResolvedRetryPolicy | undefined
  readonly signal: AbortSignal
}

/** Minimal logger surface used by the recovery listener. */
export interface OpenAICodexQuotaRecoveryLogger {
  info(message: unknown, ...parameters: unknown[]): void
  warn(message: unknown, ...parameters: unknown[]): void
}

/** Injectable hooks keep the decision and wait behavior deterministic in tests. */
export interface OpenAICodexQuotaRecoveryOptions {
  readonly enabled: () => boolean
  readonly readUsage: () => Promise<OpenAICodexUsage>
  readonly logger: OpenAICodexQuotaRecoveryLogger
  readonly now?: () => number
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<boolean>
  readonly maxStaleResets?: number
}

/** Select the usage bucket associated with a Codex model. */
export function openAICodexQuotaIdForModel(model: string | undefined): string {
  return model?.toLowerCase() === SPARK_MODEL ? SPARK_QUOTA_ID : STANDARD_QUOTA_ID
}

function quotaWindow(
  usage: OpenAICodexUsage,
  model: string | undefined,
  windowSeconds: number,
): OpenAICodexRateLimitWindow | undefined {
  const preferredId = openAICodexQuotaIdForModel(model)
  const preferred = usage.rateLimits.find(limit => limit.id === preferredId)
  // Some server responses omit the Spark bucket for a model that still uses
  // the standard Codex bucket. Falling back here avoids waiting on an
  // unrelated empty bucket while retaining the exact Spark mapping when it is
  // present.
  const limit = preferred ?? (preferredId === SPARK_QUOTA_ID
    ? usage.rateLimits.find(entry => entry.id === STANDARD_QUOTA_ID)
    : undefined)
  return limit?.windows.find(window => window.windowSeconds === windowSeconds)
}

function isFiniteRemaining(window: OpenAICodexRateLimitWindow): boolean {
  return Number.isFinite(window.remainingPercent)
}

function isResetInFuture(window: OpenAICodexRateLimitWindow, nowMs: number): boolean {
  return window.resetAt !== undefined && window.resetAt * 1_000 + OPENAI_CODEX_QUOTA_RESET_SKEW_MS > nowMs
}

/**
 * Decide whether a failed request can wait for the selected account's quota.
 * Missing or stale reset data is deliberately `unknown`, never an infinite
 * retry instruction.
 */
export function classifyOpenAICodexQuota(
  usage: OpenAICodexUsage,
  model: string | undefined,
  nowMs = Date.now(),
): OpenAICodexQuotaDecision {
  const weekly = quotaWindow(usage, model, OPENAI_CODEX_WEEKLY_WINDOW_SECONDS)
  if (weekly !== undefined && isFiniteRemaining(weekly) && weekly.remainingPercent <= 0) {
    if (weekly.resetAt === undefined || isResetInFuture(weekly, nowMs)) {
      return {
        kind: 'weekly-exhausted',
        ...weekly.resetAt === undefined ? {} : { resetAt: weekly.resetAt },
      }
    }
  }

  const fiveHour = quotaWindow(usage, model, OPENAI_CODEX_FIVE_HOUR_WINDOW_SECONDS)
  if (fiveHour !== undefined && isFiniteRemaining(fiveHour) && fiveHour.remainingPercent <= 0) {
    if (isResetInFuture(fiveHour, nowMs)) return { kind: 'wait-five-hour', resetAt: fiveHour.resetAt! }
    if (fiveHour.resetAt === undefined) return { kind: 'unknown' }
    // A reset time in the past means the endpoint may be between windows. Let
    // the failed request follow the normal provider retry path once.
    return { kind: 'available' }
  }

  if (weekly === undefined && fiveHour === undefined) return { kind: 'unknown' }
  return { kind: 'available' }
}

/** Wait for one bounded timer, resolving false when the signal aborts. */
export function cancellableOpenAICodexQuotaDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (delayMs <= 0) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => { finish(true) }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      finish(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitUntil(
  resetAt: number,
  signal: AbortSignal,
  now: () => number,
  sleep: (delayMs: number, signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  while (!signal.aborted) {
    const remaining = resetAt * 1_000 + OPENAI_CODEX_QUOTA_RESET_SKEW_MS - now()
    if (remaining <= 0) return true
    const completed = await sleep(Math.min(remaining, OPENAI_CODEX_QUOTA_WAIT_CHUNK_MS), signal)
    if (!completed) return false
  }
  return false
}

function isQuotaFailure(failure: LlmFailure): boolean {
  return failure.code === 'QUOTA' || failure.code === 'RATE_LIMIT' || failure.status === 429
}

/** Register the same-account five-hour quota waiter on the Harness waterfall. */
export function registerOpenAICodexQuotaRecovery(
  ctx: Context,
  options: OpenAICodexQuotaRecoveryOptions,
): void {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? cancellableOpenAICodexQuotaDelay
  const maxStaleResets = options.maxStaleResets ?? OPENAI_CODEX_QUOTA_MAX_STALE_RESETS
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()

  const track = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => { active.delete(tracked) })
    active.add(tracked)
    return tracked
  }

  const recover = async (
    payload: OpenAICodexRequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    if (lifetime.signal.aborted || !options.enabled() || payload.provider !== OPENAI_CODEX_PROVIDER || !isQuotaFailure(payload.failure)) {
      return next()
    }
    if (payload.signal.aborted) return undefined

    let staleResets = 0
    let lastResetAt: number | undefined
    let waitedForFiveHour = false
    while (!payload.signal.aborted && !lifetime.signal.aborted) {
      let usage: OpenAICodexUsage
      try {
        usage = await options.readUsage()
      } catch {
        // A quota probe must never turn an upstream outage into a retry loop.
        options.logger.warn('dsh-codex-connect: Codex quota status was unavailable; leaving the request terminal')
        return next()
      }
      if (payload.signal.aborted || lifetime.signal.aborted) return undefined
      const decision = classifyOpenAICodexQuota(usage, payload.agent.options.model, now())
      if (decision.kind === 'weekly-exhausted') {
        options.logger.warn('dsh-codex-connect: Codex weekly quota is exhausted; automatic account rotation is disabled')
        return undefined
      }
      if (decision.kind !== 'wait-five-hour') {
        // A successful probe after our timer is the only point at which this
        // listener owns a retry. Before any wait, delegate transient failures
        // to the normal Harness retry policy.
        return waitedForFiveHour && decision.kind === 'available'
          ? { kind: 'retry' }
          : next()
      }

      if (decision.resetAt === lastResetAt) staleResets += 1
      else {
        staleResets = 0
        lastResetAt = decision.resetAt
      }
      if (staleResets > maxStaleResets) {
        options.logger.warn('dsh-codex-connect: Codex quota reset time did not advance; leaving the request terminal')
        return undefined
      }

      options.logger.info('dsh-codex-connect: Codex five-hour quota exhausted; waiting for the provider reset')
      const waited = await waitUntil(decision.resetAt, AbortSignal.any([payload.signal, lifetime.signal]), now, sleep)
      if (!waited) return undefined
      waitedForFiveHour = true
      // Re-read usage after the boundary. The same step is retried only when
      // the provider confirms that its selected bucket is usable again.
    }
    return undefined
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => track(recover(payload, next)), { prepend: true })
  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('dsh-codex-connect quota recovery disposed'))
    await Promise.allSettled([...active])
  }, 'dsh-codex-connect: quota recovery lifecycle')
}

/** Build a quota probe that follows the active Codex-only proxy scope. */
export function createOpenAICodexQuotaUsageReader(
  store: OpenAICodexCredentialStore,
  proxyManager: OpenAICodexProxyManager,
  resolveProxyUrl: () => string | undefined,
): () => Promise<OpenAICodexUsage> {
  return () => proxyManager.run(resolveProxyUrl(), () => readOpenAICodexRateLimits(store))
}
