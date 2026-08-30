/**
 * OpenAI Codex OAuth orchestration shared by the plugin and standalone launcher.
 * @module dsh-codex-connect/auth
 */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import {
  OpenAICodexCredentialPool,
  type OpenAICodexAccountSummary,
  type OpenAICodexCredentialSource,
  OPENAI_CODEX_PROVIDER,
} from './store.ts'

/** Non-secret login state shown by the launcher. */
export interface OpenAICodexAuthStatus {
  /** Whether a stored OAuth credential exists. */
  authenticated: boolean
  /** Access-token expiry time; refresh is automatic on the next request. */
  expiresAt?: Date
  /** Redacted account metadata when the pool has been enabled. */
  accounts?: readonly OpenAICodexAccountSummary[]
  /** Opaque id of the account used by new requests. */
  activeAccountId?: string
}

/**
 * Complete provider-native OAuth and persist the resulting credential.
 * @param interaction - terminal or UI callbacks for the provider flow.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 */
export async function loginOpenAICodex(
  interaction: AuthInteraction,
  store: OpenAICodexCredentialSource = new OpenAICodexCredentialPool(),
  label?: string,
): Promise<void> {
  // A pool must not let pi-ai's single-provider `models.login()` overwrite the
  // currently active account. Complete the provider-native OAuth flow first,
  // then atomically upsert/select the returned account document.
  if (store instanceof OpenAICodexCredentialPool) {
    const oauth = openaiCodexProvider().auth.oauth
    if (oauth === undefined) throw new Error('OpenAI Codex OAuth is unavailable')
    await store.addAccount(await oauth.login(interaction), label)
    return
  }
  const models = createModels({ credentials: store })
  models.setProvider(openaiCodexProvider())
  await models.login(OPENAI_CODEX_PROVIDER, 'oauth', interaction)
}

/**
 * Remove the stored OpenAI Codex credential.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 */
export async function logoutOpenAICodex(
  store: OpenAICodexCredentialSource = new OpenAICodexCredentialPool(),
): Promise<void> {
  await store.delete(OPENAI_CODEX_PROVIDER)
}

/**
 * Read non-secret OpenAI Codex login state without refreshing the token.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 * @returns stored login state and expiry.
 */
export async function openAICodexAuthStatus(
  store: OpenAICodexCredentialSource = new OpenAICodexCredentialPool(),
): Promise<OpenAICodexAuthStatus> {
  const credential = await store.read(OPENAI_CODEX_PROVIDER)
  if (credential?.type !== 'oauth') {
    const accounts = store instanceof OpenAICodexCredentialPool ? await store.listAccounts() : undefined
    return accounts !== undefined && accounts.length > 0 ? { authenticated: true, accounts } : { authenticated: false }
  }
  if (!(store instanceof OpenAICodexCredentialPool)) return { authenticated: true, expiresAt: new Date(credential.expires) }
  const accounts = await store.listAccounts()
  const activeAccountId = await store.activeAccountId()
  return {
    authenticated: true,
    expiresAt: new Date(credential.expires),
    accounts,
    ...activeAccountId === undefined ? {} : { activeAccountId },
  }
}
