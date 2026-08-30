# Codex Connect: Alpha design

## Ownership and composition

The package registers `openai-codex` through Harness's public `LlmRuntime` and `PiAiAdapter` surfaces. The main model path is not a one-shot subagent: it remains the normal Harness agent loop, preserving native tool approvals, permission policy, streaming, attachment resolution, reasoning replay, session persistence, compaction, and recovery.

The bundle patch inserts only `llm-openai-codex`. It never writes `agent-default-model` or `web.searchProvider`. `enableSearch` and `enableImageTool` are capability gates defaulting to `false`; the optional service injections are not registered while disabled.

`autoWaitForQuota` is another explicit, default-off gate. Its request-error listener only owns recovery for the selected account's future five-hour reset: it re-reads the existing usage endpoint, waits with the turn and plugin abort signals, and returns a retry for the same failed step after the reset. `autoRotateAccounts` (also enabled by a confirmed `/persist` run) probes the durable account pool after a zero weekly window and returns the same-step retry only after selecting another usable credential. A failed probe or 401 is terminal/delegated; the plugin never purchases credits.

The Host registers `llm-openai-codex` as the plugin-owned capability settings namespace. DSH's `llm-pi-ai` catalog owns the `openai-codex` configurable-provider directory entry, while Codex Connect registers the active adapter without redeclaring that entry. The browser binds the plugin namespace through Harness's settings-scope transport and renders account, quota, Save/Discard capability controls in the existing Plugin configuration card. Revision-fenced field writes preserve unrelated settings. Committed changes reconcile search and image registrations live; the default-model and global-search namespaces are never written.

The profile uses finite SSE by default. A user may explicitly select `websocket`, `websocket-cached`, or `auto` for a long-running NAS host; the first reuses a connection without cached continuation, the second reuses both a per-session connection and continuation context, and the last lets the pinned pi-ai runtime fall back to SSE when WebSocket setup or use is unavailable. Transport is captured per profile snapshot, so a settings change affects the next request and never mutates an in-flight operation.

## OAuth persistence

The plugin keeps the legacy `$DSH_HOME/.openai-codex-auth.json` as a rollback source and imports it into `$DSH_HOME/.openai-codex-accounts/` on first use. Each account has an owner-only, strict, versioned credential file; `accounts.json` stores only opaque ids, labels, quota state and timestamps, never tokens. Writes are atomic, refresh mutations use the Harness cross-process file lock, and callers receive cloned credentials. Browser-origin trust remains in the separate `$DSH_HOME/.openai-codex-trusted-origins.json` sidecar with `version: 1`, `mode: "allowlist"`, and exact normalized HTTP(S) origins.

The settings routes and CLI reuse the existing OAuth path and route names for migration compatibility. Only an explicit login operation emits an authorization URL or code. Browser requests are accepted by default only from loopback; a remote request must use an exact effective HTTP(S) origin in the current sidecar, must not carry cross-site Fetch Metadata, and must match any supplied Origin exactly. The sidecar is re-read for every request, and unknown fields or modes fail closed. A login challenge accepts only credential-free HTTPS URLs and fails closed after 30 seconds or when the provider finishes without a URL; logout and disposal cancel pending waiters. Status responses are redacted. Doctor uses `lstat` metadata and never opens the document.

## Search and images

When `enableSearch: true`, the plugin registers its standalone search provider. It does not append a plugin-owned required-on-read Session event because an external package cannot guarantee that its `@deepseek-ai/dsh-session` module instance owns the Host persistence vocabulary; the standard web Tool call and result remain in the Session log. Harness still requires explicit `web.searchProvider: openai-codex` when multiple providers exist. Search responses are mapped to Harness text and citation records.

When `enableImageTool: true`, `view_image` is registered only after tools, filesystem, and attachment services are available. Local files remain bounded by the Harness filesystem surface. Remote images allow only credential-free public HTTP(S): all DNS answers must be public unicast, each redirect is revalidated, and each socket is pinned to the validated address to close DNS-rebinding gaps. The tool also checks bounded bytes, accepted media signatures, and current-model image support before saving a Harness attachment.

## Conflicts and diagnostics

Before registration the plugin checks current provider ids. An existing `openai-codex` adapter produces a focused message naming the likely legacy-bundle or manual-provider cause. The boot-free CLI `doctor` reports package/runtime version, OAuth path metadata, capability defaults, and safe conflict guidance without returning auth content.

## Compatibility boundary

The Alpha pins Harness `0.1.1-rc.2` development dependencies and uses its keyed `settings.plugin.item` contract; supported Node.js is `^22.19.0 || >=24.0.0`. It pins `@earendil-works/pi-ai` `0.82.1`. Backend eligibility, quotas, models, and protocol details remain controlled upstream. Tests use temporary OAuth documents and mocked network responses; CI does not perform real authentication.
