/**
 * Owner-only persistent OAuth credential storage for the OpenAI Codex bundle.
 * @module dsh-codex-connect/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Provider route and pi-ai provider id owned by this bundle. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Basename of the OAuth document inside the Harness home. */
export const OPENAI_CODEX_AUTH_FILENAME = '.openai-codex-auth.json'

/** Directory containing one owner-only credential document per ChatGPT account. */
export const OPENAI_CODEX_ACCOUNT_DIRECTORY = '.openai-codex-accounts'

/** Manifest containing only account routing metadata; it never contains tokens. */
export const OPENAI_CODEX_ACCOUNT_POOL_FILENAME = 'accounts.json'

/** Current on-disk format; pre-release readers reject every other version. */
const AUTH_FORMAT_VERSION = 1

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  credential: OAuthCredential
}

/** Store shape accepted by every Codex runtime component. */
export interface OpenAICodexCredentialSource extends CredentialStore {
  /** A stable path used for colocating trusted-origin and account metadata. */
  readonly filename?: string
}

/** Public, secret-free account state suitable for the local Web UI. */
export type OpenAICodexAccountState = 'ready' | 'weekly-exhausted' | 'five-hour-wait' | 'reauth-required' | 'disabled'

/** Public account metadata. Access and refresh tokens are intentionally absent. */
export interface OpenAICodexAccountSummary {
  /** Opaque stable id used by the account-management routes. */
  readonly id: string
  /** Optional user label; never inferred from a token. */
  readonly label: string
  /** Last few account-id characters for recognition without exposing the id. */
  readonly accountHint: string
  readonly active: boolean
  readonly state: OpenAICodexAccountState
  readonly lastUsedAt?: number
  readonly fiveHourResetAt?: number
  readonly weeklyResetAt?: number
}

interface AccountRecord {
  id: string
  label: string
  state: OpenAICodexAccountState
  createdAt: number
  lastUsedAt?: number
  fiveHourResetAt?: number
  weeklyResetAt?: number
}

interface AccountPoolDocument {
  version: 1
  activeAccountId?: string
  accounts: AccountRecord[]
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Reject a credential document readable by another POSIX user. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  /* v8 ignore next -- native Windows coverage takes the mode-less branch */
  if (process.platform === 'win32') return
  /* v8 ignore start -- POSIX tests cover this branch; Windows cannot express it */
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `openai-codex: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  /* v8 ignore stop */
}

/** Validate the strict JSON document without quoting token-bearing input. */
function parseDocument(text: string, filename: string): AuthDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`openai-codex: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`openai-codex: ${filename} must contain an object`)
  }
  const document = value as Record<string, unknown>
  if (document['version'] !== AUTH_FORMAT_VERSION) {
    throw new Error(`openai-codex: ${filename} has unsupported auth format version ${String(document['version'])}`)
  }
  if (Object.keys(document).some(key => key !== 'version' && key !== 'credential')) {
    throw new Error(`openai-codex: ${filename} contains an unknown top-level field`)
  }
  const raw = document['credential']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`openai-codex: ${filename} credential must be an object`)
  }
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) {
    throw new Error(`openai-codex: ${filename} credential contains an unknown field`)
  }
  if (credential['type'] !== 'oauth') throw new Error(`openai-codex: ${filename} credential type must be oauth`)
  for (const key of ['access', 'refresh', 'accountId'] as const) {
    if (typeof credential[key] !== 'string' || credential[key].length === 0) {
      throw new Error(`openai-codex: ${filename} credential ${key} must be a non-empty string`)
    }
  }
  if (typeof credential['expires'] !== 'number' || !Number.isFinite(credential['expires']) || credential['expires'] <= 0) {
    throw new Error(`openai-codex: ${filename} credential expires must be a positive finite number`)
  }
  return { version: AUTH_FORMAT_VERSION, credential: credential as unknown as OAuthCredential }
}

/** Detach a credential from callers that may mutate provider-owned extras. */
function cloneCredential(credential: OAuthCredential): OAuthCredential {
  return structuredClone(credential)
}

/**
 * Resolve the default OAuth document path.
 * @param dshHome - optional Harness-home override.
 * @returns the absolute owner-only document path.
 */
export function openAICodexAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_AUTH_FILENAME))
}

/** Resolve the durable multi-account manifest path. */
export function openAICodexAccountPoolPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_ACCOUNT_DIRECTORY, OPENAI_CODEX_ACCOUNT_POOL_FILENAME))
}

function accountKey(accountId: string): string {
  return `acct-${createHash('sha256').update(accountId).digest('hex').slice(0, 24)}`
}

function accountHint(accountId: string): string {
  return accountId.length <= 8 ? accountId : `…${accountId.slice(-8)}`
}

function accountFilename(manifestFilename: string, id: string): string {
  // id is generated by accountKey(), but keep this check even if a caller
  // obtains an id from a request body so path traversal cannot reach the host.
  if (!/^acct-[a-f0-9]{24}$/u.test(id)) throw new TypeError('openai-codex: account id is invalid')
  return join(dirname(manifestFilename), `${id}.json`)
}

function parsePoolDocument(text: string, filename: string): AccountPoolDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`openai-codex: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`openai-codex: ${filename} must contain an object`)
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => key !== 'version' && key !== 'activeAccountId' && key !== 'accounts')) {
    throw new Error(`openai-codex: ${filename} contains an unknown account-pool field`)
  }
  if (raw['version'] !== 1 || !Array.isArray(raw['accounts'])) {
    throw new Error(`openai-codex: ${filename} has unsupported account-pool format`)
  }
  const accounts: AccountRecord[] = []
  for (const item of raw['accounts']) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`openai-codex: ${filename} contains an invalid account record`)
    }
    const record = item as Record<string, unknown>
    if (Object.keys(record).some(key => !['id', 'label', 'state', 'createdAt', 'lastUsedAt', 'fiveHourResetAt', 'weeklyResetAt'].includes(key))) {
      throw new Error(`openai-codex: ${filename} contains an unknown account field`)
    }
    const id = record['id']
    const label = record['label']
    const state = record['state']
    const createdAt = record['createdAt']
    if (typeof id !== 'string' || !/^acct-[a-f0-9]{24}$/u.test(id)
      || typeof label !== 'string' || label.length > 120
      || (state !== 'ready' && state !== 'weekly-exhausted' && state !== 'five-hour-wait' && state !== 'reauth-required' && state !== 'disabled')
      || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
      throw new Error(`openai-codex: ${filename} contains an invalid account record`)
    }
    const optional = (key: string): number | undefined => {
      if (!Object.hasOwn(record, key)) return undefined
      const candidate = record[key]
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
        throw new Error(`openai-codex: ${filename} contains an invalid account timestamp`)
      }
      return candidate
    }
    const parsed: AccountRecord = {
      id,
      label,
      state,
      createdAt,
    }
    const lastUsedAt = optional('lastUsedAt')
    const fiveHourResetAt = optional('fiveHourResetAt')
    const weeklyResetAt = optional('weeklyResetAt')
    if (lastUsedAt !== undefined) parsed.lastUsedAt = lastUsedAt
    if (fiveHourResetAt !== undefined) parsed.fiveHourResetAt = fiveHourResetAt
    if (weeklyResetAt !== undefined) parsed.weeklyResetAt = weeklyResetAt
    accounts.push(parsed)
  }
  const active = raw['activeAccountId']
  if (active !== undefined && (typeof active !== 'string' || !accounts.some(account => account.id === active))) {
    throw new Error(`openai-codex: ${filename} points to an unknown active account`)
  }
  return { version: 1, accounts, ...active === undefined ? {} : { activeAccountId: active } }
}

function cloneSummary(summary: OpenAICodexAccountSummary): OpenAICodexAccountSummary {
  return { ...summary }
}

function credentialAccountId(credential: OAuthCredential): string {
  const value = credential.accountId
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('openai-codex: OAuth credential accountId is required')
  return value
}

/** File-backed pi-ai store scoped to the single OpenAI Codex provider. */
export class OpenAICodexCredentialStore implements OpenAICodexCredentialSource {
  /** Absolute credential document path. */
  readonly filename: string

  /**
   * @param filename - explicit document path, defaulting under `$DSH_HOME`.
   */
  constructor(filename: string = openAICodexAuthPath()) {
    this.filename = resolve(filename)
  }

  /** Read and validate the current document without acquiring the writer lock. */
  private async readCurrent(): Promise<OAuthCredential | undefined> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    return cloneCredential(parseDocument(text, this.filename).credential)
  }

  /** @inheritdoc */
  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === OPENAI_CODEX_PROVIDER ? this.readCurrent() : undefined
  }

  /** @inheritdoc */
  async list(): Promise<readonly CredentialInfo[]> {
    return await this.readCurrent() === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  /** @inheritdoc */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    }
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const current = await this.readCurrent()
      const candidate = await fn(current)
      if (candidate === undefined) return current
      const document = parseDocument(JSON.stringify({
        version: AUTH_FORMAT_VERSION,
        credential: candidate,
      }), this.filename)
      await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return cloneCredential(document.credential)
    })
  }

  /** @inheritdoc */
  async delete(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, () => rm(this.filename, { force: true }))
  }
}

/**
 * Durable multi-account view for pi-ai's single-provider CredentialStore API.
 *
 * pi-ai deliberately accepts one credential per provider.  This class keeps
 * the provider id stable while atomically moving an active-account pointer
 * between separate credential files.  A request already in flight owns the
 * token it resolved; a quota retry resolves the same Harness step against the
 * newly selected account.  No session, transcript, plan, worktree, or browser
 * context is recreated during rotation.
 */
export class OpenAICodexCredentialPool implements OpenAICodexCredentialSource {
  readonly filename: string
  private readonly legacyFilename: string
  private readonly accountsDirectory: string
  private initialized: Promise<void> | undefined

  constructor(
    legacyFilename: string = openAICodexAuthPath(),
    manifestFilename?: string,
  ) {
    this.legacyFilename = resolve(legacyFilename)
    this.filename = resolve(manifestFilename ?? join(dirname(this.legacyFilename), OPENAI_CODEX_ACCOUNT_DIRECTORY, OPENAI_CODEX_ACCOUNT_POOL_FILENAME))
    this.accountsDirectory = dirname(this.filename)
  }

  private async readPool(): Promise<AccountPoolDocument> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return { version: 1, accounts: [] }
      throw error
    }
    return parsePoolDocument(text, this.filename)
  }

  private async writePool(document: AccountPoolDocument): Promise<void> {
    await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized !== undefined) return this.initialized
    this.initialized = (async () => {
      await mkdir(this.accountsDirectory, { recursive: true, mode: 0o700 })
      await withFileLock(this.filename, async () => {
        // A present manifest is authoritative, including an intentionally
        // empty pool after the user removed the last account.  The legacy
        // document stays on disk for rollback, so importing solely because
        // `accounts` is empty would resurrect a deleted account after a
        // process restart.
        const manifestExists = await stat(this.filename).then(() => true).catch(error => {
          if (isENOENT(error)) return false
          throw error
        })
        const existing = await this.readPool()
        if (manifestExists) {
          // Keep an old legacy file untouched so a failed upgrade can be
          // rolled back without losing the user's original login.
          return
        }
        const legacy = new OpenAICodexCredentialStore(this.legacyFilename)
        const credential = await legacy.read(OPENAI_CODEX_PROVIDER)
        if (credential?.type !== 'oauth') {
          await this.writePool(existing)
          return
        }
        const accountId = credentialAccountId(credential)
        const id = accountKey(accountId)
        const record: AccountRecord = {
          id,
          label: `Account ${accountId.slice(-4)}`,
          state: 'ready',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        }
        const account = new OpenAICodexCredentialStore(accountFilename(this.filename, id))
        await account.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential))
        await this.writePool({ version: 1, activeAccountId: id, accounts: [record] })
      })
    })()
    try {
      await this.initialized
    } catch (error) {
      this.initialized = undefined
      throw error
    }
  }

  private async activeRecord(): Promise<AccountRecord | undefined> {
    const pool = await this.readPool()
    return pool.activeAccountId === undefined ? undefined : pool.accounts.find(account => account.id === pool.activeAccountId)
  }

  /** Return an isolated file-backed view for one account after validating its id. */
  async storeForAccount(id: string): Promise<OpenAICodexCredentialStore> {
    await this.ensureInitialized()
    const pool = await this.readPool()
    if (!pool.accounts.some(account => account.id === id)) throw new Error('openai-codex: account is not registered')
    return new OpenAICodexCredentialStore(accountFilename(this.filename, id))
  }

  /** Return the currently selected opaque account id. */
  async activeAccountId(): Promise<string | undefined> {
    await this.ensureInitialized()
    return (await this.activeRecord())?.id
  }

  /** List all accounts without returning access or refresh tokens. */
  async listAccounts(): Promise<readonly OpenAICodexAccountSummary[]> {
    await this.ensureInitialized()
    const pool = await this.readPool()
    const result: OpenAICodexAccountSummary[] = []
    for (const record of pool.accounts) {
      const credential = await new OpenAICodexCredentialStore(accountFilename(this.filename, record.id)).read(OPENAI_CODEX_PROVIDER)
      if (credential?.type !== 'oauth') continue
      result.push(cloneSummary({
        id: record.id,
        label: record.label,
        accountHint: accountHint(credentialAccountId(credential)),
        active: record.id === pool.activeAccountId,
        state: record.state,
        ...record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt },
        ...record.fiveHourResetAt === undefined ? {} : { fiveHourResetAt: record.fiveHourResetAt },
        ...record.weeklyResetAt === undefined ? {} : { weeklyResetAt: record.weeklyResetAt },
      }))
    }
    return result
  }

  /** Add or replace a provider-native OAuth credential and select it. */
  async addAccount(credential: OAuthCredential, label?: string): Promise<string> {
    if (credential.type !== 'oauth') throw new TypeError('openai-codex: OAuth credential is required')
    // Reuse the strict document validator before any secret reaches disk.
    const validated = parseDocument(JSON.stringify({ version: AUTH_FORMAT_VERSION, credential }), this.filename).credential
    await this.ensureInitialized()
    const validatedAccountId = credentialAccountId(validated)
    const id = accountKey(validatedAccountId)
    await withFileLock(this.filename, async () => {
      const pool = await this.readPool()
      const existing = pool.accounts.find(account => account.id === id)
      const now = Date.now()
      const record: AccountRecord = {
        id,
        label: label?.trim().slice(0, 120) || existing?.label || `Account ${validatedAccountId.slice(-4)}`,
        state: 'ready',
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
      }
      const account = new OpenAICodexCredentialStore(accountFilename(this.filename, id))
      await account.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(validated))
      await this.writePool({
        version: 1,
        activeAccountId: id,
        accounts: [...pool.accounts.filter(item => item.id !== id), record],
      })
    })
    return id
  }

  /** Select an existing account; this does not touch any Harness session state. */
  async switchActive(id: string): Promise<void> {
    await this.ensureInitialized()
    await withFileLock(this.filename, async () => {
      const pool = await this.readPool()
      const record = pool.accounts.find(account => account.id === id)
      if (record === undefined) throw new Error('openai-codex: account is not registered')
      const credential = await new OpenAICodexCredentialStore(accountFilename(this.filename, id)).read(OPENAI_CODEX_PROVIDER)
      if (credential?.type !== 'oauth') throw new Error('openai-codex: account credential is missing')
      record.lastUsedAt = Date.now()
      record.state = 'ready'
      delete record.fiveHourResetAt
      delete record.weeklyResetAt
      await this.writePool({ ...pool, activeAccountId: id })
    })
  }

  /** Mark quota/auth state without storing provider response bodies or tokens. */
  async markAccountState(
    id: string,
    state: OpenAICodexAccountState,
    reset: { fiveHourResetAt?: number; weeklyResetAt?: number } = {},
  ): Promise<void> {
    await this.ensureInitialized()
    await withFileLock(this.filename, async () => {
      const pool = await this.readPool()
      const record = pool.accounts.find(account => account.id === id)
      if (record === undefined) return
      record.state = state
      if (reset.fiveHourResetAt === undefined) delete record.fiveHourResetAt
      else record.fiveHourResetAt = reset.fiveHourResetAt
      if (reset.weeklyResetAt === undefined) delete record.weeklyResetAt
      else record.weeklyResetAt = reset.weeklyResetAt
      await this.writePool(pool)
    })
  }

  /** Remove one account. The next account becomes active when necessary. */
  async removeAccount(id: string): Promise<void> {
    await this.ensureInitialized()
    await withFileLock(this.filename, async () => {
      const pool = await this.readPool()
      if (!pool.accounts.some(account => account.id === id)) return
      await rm(accountFilename(this.filename, id), { force: true })
      const accounts = pool.accounts.filter(account => account.id !== id)
      const activeAccountId = pool.activeAccountId === id ? accounts[0]?.id : pool.activeAccountId
      await this.writePool({ version: 1, accounts, ...activeAccountId === undefined ? {} : { activeAccountId } })
    })
  }

  /** @inheritdoc */
  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined
    await this.ensureInitialized()
    const record = await this.activeRecord()
    return record === undefined
      ? undefined
      : new OpenAICodexCredentialStore(accountFilename(this.filename, record.id)).read(providerId)
  }

  /** @inheritdoc */
  async list(): Promise<readonly CredentialInfo[]> {
    return (await this.read(OPENAI_CODEX_PROVIDER)) === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  /** @inheritdoc */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    }
    await this.ensureInitialized()
    return withFileLock(this.filename, async () => {
      const pool = await this.readPool()
      const record = pool.activeAccountId === undefined ? undefined : pool.accounts.find(account => account.id === pool.activeAccountId)
      const account = record === undefined ? undefined : new OpenAICodexCredentialStore(accountFilename(this.filename, record.id))
      const current = account === undefined ? undefined : await account.read(providerId)
      const candidate = await fn(current)
      if (candidate === undefined) return current
      if (candidate.type !== 'oauth') throw new TypeError('openai-codex: only OAuth credentials are supported')
      if (account === undefined) {
        const validated = parseDocument(JSON.stringify({ version: AUTH_FORMAT_VERSION, credential: candidate }), this.filename).credential
        const validatedAccountId = credentialAccountId(validated)
        const id = accountKey(validatedAccountId)
        const now = Date.now()
        const newRecord: AccountRecord = {
          id,
          label: `Account ${validatedAccountId.slice(-4)}`,
          state: 'ready',
          createdAt: now,
          lastUsedAt: now,
        }
        const newAccount = new OpenAICodexCredentialStore(accountFilename(this.filename, id))
        await newAccount.modify(providerId, () => Promise.resolve(validated))
        await this.writePool({ version: 1, activeAccountId: id, accounts: [...pool.accounts, newRecord] })
        return validated
      }
      if (candidate.type === 'oauth' && current?.type === 'oauth' && candidate.accountId !== current.accountId) {
        throw new Error('openai-codex: account id cannot change during credential refresh')
      }
      const written = await account.modify(providerId, () => Promise.resolve(candidate))
      if (record !== undefined) record.lastUsedAt = Date.now()
      await this.writePool(pool)
      return written
    })
  }

  /** @inheritdoc */
  async delete(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    const active = await this.activeAccountId()
    if (active !== undefined) await this.removeAccount(active)
  }
}
