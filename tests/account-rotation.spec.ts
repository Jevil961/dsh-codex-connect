import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  createOpenAICodexQuotaAccountRotator,
  OPENAI_CODEX_WEEKLY_WINDOW_SECONDS,
} from '../src/quota-recovery.ts'
import { OpenAICodexCredentialPool, OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import { OpenAICodexProxyManager } from '../src/provider-proxy.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(accountId: string): OAuthCredential {
  return {
    type: 'oauth',
    access: `${accountId}-access`,
    refresh: `${accountId}-refresh`,
    expires: Date.now() + 60_000,
    accountId,
  }
}

function usageResponse(accountId: string): Response {
  const exhausted = accountId === 'account-one'
  return new Response(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: exhausted ? 0 : 20, limit_window_seconds: 5 * 60 * 60 },
      secondary_window: { used_percent: exhausted ? 100 : 20, limit_window_seconds: OPENAI_CODEX_WEEKLY_WINDOW_SECONDS },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Codex account rotation', () => {
  it('probes other account files and selects the first weekly-available account', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-account-rotation-'))
    const pool = new OpenAICodexCredentialPool(join(root, 'legacy.json'), join(root, 'pool', 'accounts.json'))
    const first = await pool.addAccount(credential('account-one'))
    await pool.addAccount(credential('account-two'))
    await pool.switchActive(first)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get('chatgpt-account-id') ?? ''
      expect(String(input)).toContain('/wham/usage')
      return usageResponse(accountId)
    }))
    const proxy = new OpenAICodexProxyManager()
    try {
      const rotate = createOpenAICodexQuotaAccountRotator(pool, proxy, () => undefined)
      await expect(rotate('gpt-5.6-sol', new AbortController().signal)).resolves.toEqual({ rotated: true })
      const active = await pool.read(OPENAI_CODEX_PROVIDER)
      expect(active).toMatchObject({ type: 'oauth', accountId: 'account-two' })
      expect((await pool.listAccounts()).find(item => item.id === first)?.state).toBe('ready')
    } finally {
      await proxy.dispose()
    }
  })

  it('returns the active account reset when every account is exhausted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-account-rotation-'))
    const pool = new OpenAICodexCredentialPool(join(root, 'legacy.json'), join(root, 'pool', 'accounts.json'))
    await pool.addAccount(credential('account-one'))
    const resetAt = Math.floor(Date.now() / 1_000) + 120
    const active = await pool.activeAccountId()
    expect(active).toBeDefined()
    await pool.markAccountState(active!, 'weekly-exhausted', { weeklyResetAt: resetAt })
    const proxy = new OpenAICodexProxyManager()
    try {
      const rotate = createOpenAICodexQuotaAccountRotator(pool, proxy, () => undefined)
      await expect(rotate('gpt-5.6-sol', new AbortController().signal)).resolves.toEqual({ rotated: false, resetAt })
    } finally {
      await proxy.dispose()
    }
  })
})
