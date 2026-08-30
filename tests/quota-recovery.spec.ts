import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  classifyOpenAICodexQuota,
  OPENAI_CODEX_FIVE_HOUR_WINDOW_SECONDS,
  OPENAI_CODEX_WEEKLY_WINDOW_SECONDS,
  registerOpenAICodexQuotaRecovery,
} from '../src/quota-recovery.ts'
import type { OpenAICodexUsage } from '../src/usage.ts'

const NOW_MS = 1_800_000_000_000

function usage(
  fiveHour: { remainingPercent: number; resetAt?: number },
  weekly: { remainingPercent: number; resetAt?: number },
  id = 'codex',
): OpenAICodexUsage {
  return {
    rateLimits: [{
      id,
      windows: [
        { ...fiveHour, windowSeconds: OPENAI_CODEX_FIVE_HOUR_WINDOW_SECONDS },
        { ...weekly, windowSeconds: OPENAI_CODEX_WEEKLY_WINDOW_SECONDS },
      ],
    }],
  }
}

describe('OpenAI Codex quota recovery', () => {
  it('waits for an exhausted five-hour window when its reset is in the future', () => {
    const resetAt = Math.floor(NOW_MS / 1_000) + 60
    expect(classifyOpenAICodexQuota(
      usage({ remainingPercent: 0, resetAt }, { remainingPercent: 80, resetAt: resetAt + 1000 }),
      'gpt-5.6-sol',
      NOW_MS,
    )).toEqual({ kind: 'wait-five-hour', resetAt })
  })

  it('treats weekly exhaustion as terminal before considering a five-hour reset', () => {
    const resetAt = Math.floor(NOW_MS / 1_000) + 60
    expect(classifyOpenAICodexQuota(
      usage({ remainingPercent: 0, resetAt }, { remainingPercent: 0, resetAt: resetAt + 3600 }),
      'gpt-5.6-sol',
      NOW_MS,
    )).toEqual({ kind: 'weekly-exhausted', resetAt: resetAt + 3600 })
  })

  it('does not invent a wait when the server omits the five-hour reset', () => {
    expect(classifyOpenAICodexQuota(
      usage({ remainingPercent: 0 }, { remainingPercent: 80 }),
      'gpt-5.6-sol',
      NOW_MS,
    )).toEqual({ kind: 'unknown' })
  })

  it('uses the Spark bucket when the selected model is Spark', () => {
    const resetAt = Math.floor(NOW_MS / 1_000) + 60
    expect(classifyOpenAICodexQuota(
      usage({ remainingPercent: 0, resetAt }, { remainingPercent: 80 }, 'codex_bengalfox'),
      'gpt-5.3-codex-spark',
      NOW_MS,
    )).toEqual({ kind: 'wait-five-hour', resetAt })
  })

  it('waits, re-reads usage, and owns the retry only after reset', async () => {
    const resetAt = Math.floor(NOW_MS / 1_000) + 60
    let now = NOW_MS
    let reads = 0
    const sleep = vi.fn(async (_delayMs: number, _signal: AbortSignal): Promise<boolean> => {
      now = resetAt * 1_000 + 2_000
      return true
    })
    const readUsage = vi.fn(async (): Promise<OpenAICodexUsage> => {
      reads += 1
      return reads === 1
        ? usage({ remainingPercent: 0, resetAt }, { remainingPercent: 80, resetAt: resetAt + 1000 })
        : usage({ remainingPercent: 100, resetAt }, { remainingPercent: 80, resetAt: resetAt + 1000 })
    })
    const listener = vi.fn()
    const on = vi.fn((_name: string, callback: unknown) => {
      listener.mockImplementation(callback as (...args: unknown[]) => unknown)
      return () => true
    })
    const effect = vi.fn()
    const ctx = { on, effect } as unknown as Context
    registerOpenAICodexQuotaRecovery(ctx, {
      enabled: () => true,
      readUsage,
      sleep,
      now: () => now,
      logger: { info: vi.fn(), warn: vi.fn() },
    })

    const next = vi.fn(async () => undefined)
    const result = await listener({
      agent: { options: { model: 'gpt-5.6-sol' } },
      turn: 1,
      step: 1,
      provider: 'openai-codex',
      failure: { code: 'QUOTA', message: 'quota exceeded' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }, next)
    expect(result).toEqual({ kind: 'retry' })
    expect(readUsage).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('does not call downstream recovery or rotate accounts on weekly exhaustion', async () => {
    const resetAt = Math.floor(NOW_MS / 1_000) + 60
    const listener = vi.fn()
    const on = vi.fn((_name: string, callback: unknown) => {
      listener.mockImplementation(callback as (...args: unknown[]) => unknown)
      return () => true
    })
    const ctx = { on, effect: vi.fn() } as unknown as Context
    const warn = vi.fn()
    registerOpenAICodexQuotaRecovery(ctx, {
      enabled: () => true,
      readUsage: async () => usage({ remainingPercent: 0, resetAt }, { remainingPercent: 0, resetAt: resetAt + 3600 }),
      logger: { info: vi.fn(), warn },
    })
    const next = vi.fn(async () => undefined)
    await expect(listener({
      agent: { options: { model: 'gpt-5.6-sol' } },
      turn: 1,
      step: 1,
      provider: 'openai-codex',
      failure: { code: 'QUOTA', message: 'quota exceeded' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }, next)).resolves.toBeUndefined()
    expect(next).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('automatic account rotation is disabled'))
  })
})

