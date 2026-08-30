import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  OpenAICodexCredentialPool,
  OpenAICodexCredentialStore,
  OPENAI_CODEX_PROVIDER,
} from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(accountId: string, access = `${accountId}-access`): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh: `${accountId}-refresh`,
    expires: Date.now() + 60_000,
    accountId,
  }
}

async function paths(): Promise<{ legacy: string; manifest: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-account-pool-'))
  return { legacy: join(root, '.openai-codex-auth.json'), manifest: join(root, '.openai-codex-accounts', 'accounts.json') }
}

describe('OpenAICodexCredentialPool', () => {
  it('migrates the legacy credential and keeps every account in its own file', async () => {
    const { legacy, manifest } = await paths()
    const old = new OpenAICodexCredentialStore(legacy)
    await old.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential('legacy-account')))
    const pool = new OpenAICodexCredentialPool(legacy, manifest)

    await expect(pool.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({ accountId: 'legacy-account' })
    const accounts = await pool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ active: true, accountHint: '…-account' })
    const onDisk = await readFile(manifest, 'utf8')
    expect(onDisk).not.toContain('legacy-account')
    expect(onDisk).not.toContain('legacy-account-access')
  })

  it('switches, refreshes, and removes accounts without crossing credentials', async () => {
    const { legacy, manifest } = await paths()
    const pool = new OpenAICodexCredentialPool(legacy, manifest)
    const first = await pool.addAccount(credential('account-one'))
    const second = await pool.addAccount(credential('account-two'))
    expect((await pool.read(OPENAI_CODEX_PROVIDER))?.type).toBe('oauth')
    expect((await pool.read(OPENAI_CODEX_PROVIDER) as OAuthCredential).accountId).toBe('account-two')
    await pool.switchActive(first)
    await pool.modify(OPENAI_CODEX_PROVIDER, current => Promise.resolve({ ...(current as OAuthCredential), access: 'refreshed-one' }))
    expect((await pool.read(OPENAI_CODEX_PROVIDER) as OAuthCredential).access).toBe('refreshed-one')
    await pool.switchActive(second)
    expect((await pool.read(OPENAI_CODEX_PROVIDER) as OAuthCredential).access).toBe('account-two-access')
    await pool.removeAccount(first)
    expect((await pool.listAccounts()).map(item => item.id)).toEqual([second])
    const firstFile = join(root!, '.openai-codex-accounts', `${first}.json`)
    await expect(readFile(firstFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not resurrect a removed legacy account after restarting the pool', async () => {
    const { legacy, manifest } = await paths()
    const old = new OpenAICodexCredentialStore(legacy)
    await old.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential('legacy-account')))
    const pool = new OpenAICodexCredentialPool(legacy, manifest)
    const id = await pool.activeAccountId()
    expect(id).toBeDefined()
    await pool.removeAccount(id!)

    const restarted = new OpenAICodexCredentialPool(legacy, manifest)
    await expect(restarted.listAccounts()).resolves.toEqual([])
    await expect(restarted.read(OPENAI_CODEX_PROVIDER)).resolves.toBeUndefined()
    await expect(readFile(legacy, 'utf8')).resolves.toContain('legacy-account')
  })

  it('rejects malformed pool metadata and enforces owner-only files', async () => {
    const { legacy, manifest } = await paths()
    await mkdir(join(root!, '.openai-codex-accounts'), { recursive: true })
    await writeFile(manifest, JSON.stringify({ version: 1, accounts: [{ id: 'not-an-id', label: 'x', state: 'ready', createdAt: Date.now() }] }), { mode: 0o600 })
    const pool = new OpenAICodexCredentialPool(legacy, manifest)
    await expect(pool.listAccounts()).rejects.toThrow(/invalid account record/u)
    if (process.platform !== 'win32') {
      await writeFile(manifest, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o644 })
      await chmod(manifest, 0o644)
      await expect(pool.listAccounts()).rejects.toThrow(/readable beyond its owner/u)
    }
  })
})
