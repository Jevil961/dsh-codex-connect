/** Node-free route constants shared by the Host and browser plugin halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
/** Plugin-owned browser-login endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
/** Plugin-owned logout endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
/** Redacted account list and active-account metadata. */
export const OPENAI_CODEX_AUTH_ACCOUNTS_PATH = '/plugins/dsh-openai-codex/auth/accounts'
/** Select one previously added account without changing the Harness session. */
export const OPENAI_CODEX_AUTH_ACCOUNT_SELECT_PATH = '/plugins/dsh-openai-codex/auth/accounts/select'
/** Remove one account from the local pool. */
export const OPENAI_CODEX_AUTH_ACCOUNT_REMOVE_PATH = '/plugins/dsh-openai-codex/auth/accounts/remove'
