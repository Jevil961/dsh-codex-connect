/**
 * The `/persist` command: a durable, plan-first driver for long-running work.
 *
 * This is intentionally implemented as a Harness command instead of a second
 * chat UI.  The command is recorded by dsh-commands, the workflow state is
 * recorded in the session event log, and the existing goal round driver owns
 * the between-turn continuation.  That gives a resumed Harness session the
 * same plan and execution state without keeping a second database in the
 * plugin.
 *
 * @module dsh-codex-connect/persist
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { GoalService, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'

/** Version of the plugin-owned event payload. Increment on incompatible changes. */
export const PERSIST_CHANGE_VERSION = 1 as const

/** Maximum amount of model text retained in the structured workflow event. */
export const PERSIST_PLAN_MAX_CHARS = 16_000
export const PERSIST_QUESTIONS_MAX_CHARS = 8_000
export const PERSIST_REASON_MAX_CHARS = 4_000

/** The default safety bound for one confirmed run. */
export const PERSIST_DEFAULT_MAX_GOAL_ROUNDS = 256

export type PersistPhase =
  | 'planning'
  | 'needs-input'
  | 'awaiting-confirmation'
  | 'running'
  | 'waiting-quota'
  | 'weekly-exhausted'
  | 'paused'
  | 'complete'
  | 'stopped'
  | 'failed'

/** Durable state of one `/persist` workflow. All fields are JSON-safe. */
export interface PersistState {
  readonly phase: PersistPhase
  readonly objective: string
  readonly plan: string | null
  readonly questions: string | null
  readonly addendum: string | null
  readonly lastAnswer: string | null
  readonly reason: string | null
  readonly updatedAt: number
}

/** Session event written after each accepted workflow transition. */
export interface PersistChange extends PersistState {
  readonly kind: 'persist/change'
  readonly version: typeof PERSIST_CHANGE_VERSION
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-value `/persist` state; the last change wins. */
    'persist/change': PersistChange
  }
}

type PersistCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'start'; readonly objective: string }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'answer'; readonly answer: string }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'invalid'; readonly message: string }

const USAGE = 'Usage: /persist <objective> | confirm | answer <text> | pause | resume | stop'
const PLAN_MARKER = '[NASAGENT_PERSIST_PLAN]'
const QUESTIONS_MARKER = '[NASAGENT_PERSIST_QUESTIONS]'
const PLAN_END_MARKER = '[NASAGENT_PERSIST_PLAN_END]'
const ADDENDUM_MARKER = '[NASAGENT_PERSIST_ADDENDUM]'
const ADDENDUM_END_MARKER = '[NASAGENT_PERSIST_ADDENDUM_END]'
const DONE_MARKER = '[NASAGENT_PERSIST_DONE]'

const EMPTY_STATE: Omit<PersistState, 'updatedAt'> = {
  phase: 'planning',
  objective: '',
  plan: null,
  questions: null,
  addendum: null,
  lastAnswer: null,
  reason: null,
}

/** Trim and bound untrusted model/user text before it enters a durable event. */
function bounded(value: string, max: number): string {
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function nullableText(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null
  const text = bounded(value, max)
  return text.length === 0 ? null : text
}

/** Parse the command-owned grammar without interpreting an arbitrary objective. */
export function parsePersistCommand(rawInput: string): PersistCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'confirm' || control === 'approve') return { kind: 'confirm' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume' || control === 'continue') return { kind: 'resume' }
  if (control === 'stop' || control === 'cancel') return { kind: 'stop' }
  if (/^answer(?=\s)/iu.test(input)) {
    const answer = input.slice(6).trim()
    return answer.length === 0
      ? { kind: 'invalid', message: `Answer text is required. ${USAGE}` }
      : { kind: 'answer', answer }
  }
  if (/^(confirm|approve|pause|resume|continue|stop|cancel|answer)$/iu.test(input)) {
    return { kind: 'invalid', message: `This command needs its argument. ${USAGE}` }
  }
  return { kind: 'start', objective: input }
}

/** Extract plain text from an assistant message while tolerating future blocks. */
export function assistantText(message: AssistantMessage): string {
  const chunks: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      chunks.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string' && (record.type === undefined || record.type === 'text')) {
      chunks.push(record.text)
    }
  }
  visit(message.content)
  return chunks.join('\n').trim()
}

/** Parsed plan markers emitted by the planning turn. */
export interface ParsedPersistPlan {
  readonly plan: string
  readonly questions: string | null
}

/** Parse the complete, explicit plan envelope. Partial/truncated envelopes are ignored. */
export function parsePersistPlan(text: string): ParsedPersistPlan | undefined {
  const planStart = text.indexOf(PLAN_MARKER)
  if (planStart < 0) return undefined
  const questionsStart = text.indexOf(QUESTIONS_MARKER, planStart + PLAN_MARKER.length)
  const end = text.indexOf(PLAN_END_MARKER, questionsStart >= 0 ? questionsStart : planStart + PLAN_MARKER.length)
  if (questionsStart < 0 || end < 0 || questionsStart > end) return undefined
  const plan = bounded(text.slice(planStart + PLAN_MARKER.length, questionsStart), PERSIST_PLAN_MAX_CHARS)
  const rawQuestions = bounded(text.slice(questionsStart + QUESTIONS_MARKER.length, end), PERSIST_QUESTIONS_MAX_CHARS)
  if (plan.length === 0) return undefined
  const questions = /^(none|无|无。|无问题|none\.)$/iu.test(rawQuestions) ? null : (rawQuestions || null)
  return { plan, questions }
}

/** Parse an execution-time addendum and completion signal. */
export function parsePersistExecutionSignals(text: string): {
  readonly addendum: string | null
  readonly done: boolean
} {
  const start = text.indexOf(ADDENDUM_MARKER)
  const end = start < 0 ? -1 : text.indexOf(ADDENDUM_END_MARKER, start + ADDENDUM_MARKER.length)
  const addendum = start >= 0 && end >= 0
    ? nullableText(text.slice(start + ADDENDUM_MARKER.length, end), PERSIST_PLAN_MAX_CHARS)
    : null
  return { addendum, done: text.includes(DONE_MARKER) }
}

/** Replay the last valid whole-value state from a session log. */
export function foldPersistState(events: readonly SessionEvent[]): PersistState | undefined {
  let state: PersistState | undefined
  for (const event of events) {
    if (event.type !== 'persist/change') continue
    const value = event.data
    if (value.kind !== 'persist/change' || value.version !== PERSIST_CHANGE_VERSION) continue
    state = {
      phase: value.phase,
      objective: value.objective,
      plan: value.plan,
      questions: value.questions,
      addendum: value.addendum,
      lastAnswer: value.lastAnswer,
      reason: value.reason,
      updatedAt: value.updatedAt,
    }
  }
  return state
}

function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

function phaseLabel(phase: PersistPhase): string {
  switch (phase) {
    case 'planning': return 'planning'
    case 'needs-input': return 'needs input'
    case 'awaiting-confirmation': return 'awaiting confirmation'
    case 'running': return 'running'
    case 'waiting-quota': return 'waiting for five-hour quota reset'
    case 'weekly-exhausted': return 'weekly quota exhausted'
    case 'paused': return 'paused'
    case 'complete': return 'complete'
    case 'stopped': return 'stopped'
    case 'failed': return 'failed'
  }
}

function renderState(state: PersistState | undefined): CommandResult {
  if (state === undefined) return { kind: 'success', text: `No persistent task is set.\n${USAGE}` }
  const lines = [
    `Persist status: ${phaseLabel(state.phase)}`,
    `Objective: ${state.objective}`,
  ]
  if (state.plan !== null) lines.push(`Plan:\n${state.plan}`)
  if (state.questions !== null) lines.push(`Questions requiring your answer:\n${state.questions}`)
  if (state.addendum !== null) lines.push(`Unapproved addendum (not executed):\n${state.addendum}`)
  if (state.reason !== null) lines.push(`Details: ${state.reason}`)
  if (state.phase === 'weekly-exhausted') {
    lines.push('Automatic account switching is disabled. Select/switch the provider account explicitly, then run /persist resume.')
  }
  if (state.phase === 'awaiting-confirmation') lines.push('Run /persist confirm only after reviewing the plan.')
  if (state.phase === 'needs-input') lines.push('Reply with /persist answer <your answer>; no implementation will start before confirmation.')
  if (state.phase === 'running' || state.phase === 'waiting-quota') {
    lines.push(`The execution goal is bounded to ${PERSIST_DEFAULT_MAX_GOAL_ROUNDS} rounds and can be paused with /persist pause.`)
  }
  return { kind: 'success', text: lines.join('\n\n') }
}

function plannerPrompt(objective: string, answer?: string): string {
  const clarification = answer === undefined
    ? ''
    : `\nThe user supplied this clarification. Reconcile it with the existing plan and ask again only for decisions that are still genuinely missing:\n${answer}\n`
  return [
    '<persist_planning>',
    'You are in NASAgent /persist planning phase. Do not implement anything yet: do not write files, run mutating commands, commit, send network requests, or change browser state.',
    'First understand the requested product/task and, when it references an existing app or convention, use only safe read-only research to establish what it actually does.',
    'Identify the current pain points, assumptions, dependencies, security/privacy risks, data and deployment constraints, acceptance criteria, implementation steps, tests, UI/UX improvements, accessibility, performance, rollback and verification.',
    'Think of useful complementary fixes, but keep them in the plan. Do not silently expand the scope during execution.',
    clarification,
    'Ask every question whose answer would change the implementation. If none remain, write NONE.',
    `Output exactly one complete envelope:\n${PLAN_MARKER}\n<complete markdown plan, including pain points, scope and acceptance criteria>\n${QUESTIONS_MARKER}\n<questions or NONE>\n${PLAN_END_MARKER}`,
    '</persist_planning>',
  ].join('\n')
}

function executionPrompt(state: PersistState): string {
  return [
    '<persist_execution>',
    'The user explicitly confirmed the following plan. Execute it continuously in this session, using the normal Harness tools, approvals, project/worktree rules and tests.',
    `Objective: ${state.objective}`,
    'Approved plan:',
    state.plan ?? '(plan unavailable; stop and ask the user)',
    '',
    'Keep the approved scope locked. If you discover a useful defect, feature, UI or UX idea outside this plan, do not implement it immediately: finish or safely checkpoint the approved work, then emit an addendum envelope and wait for /persist confirm.',
    `Addendum format when needed:\n${ADDENDUM_MARKER}\n<proposal and why it matters>\n${ADDENDUM_END_MARKER}`,
    `When the entire approved objective is verified, mark the Harness goal complete and include ${DONE_MARKER} in your final report. If a quota, approval or external dependency blocks progress, state it precisely so the workflow can be resumed without losing context.`,
    '</persist_execution>',
  ].join('\n')
}

type GoalContext = Context & { goals?: GoalService }

function goalsOf(ctx: Context): GoalService | undefined {
  return (ctx as GoalContext).goals
}

function quotaLike(value: unknown): boolean {
  const text = (() => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name} ${value.message}`
    if (typeof value !== 'object' || value === null) return String(value)
    const record = value as Record<string, unknown>
    return [record.code, record.message, record.status, record.error].filter(Boolean).join(' ')
  })().toLowerCase()
  return /quota|rate.?limit|too many requests|429|five.?hour|weekly|usage limit|capacity/.test(text)
}

function weeklyLike(value: unknown): boolean {
  const text = (() => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name} ${value.message}`
    if (typeof value !== 'object' || value === null) return String(value)
    const record = value as Record<string, unknown>
    return [record.code, record.message, record.error].filter(Boolean).join(' ')
  })().toLowerCase()
  return /weekly|week.?limit|seven.?day/.test(text)
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Register the command and return a small hook used by Codex quota recovery.
 * Persist work opts into the existing five-hour wait/retry path; it never
 * selects another credential silently.
 */
export function registerPersistCommand(ctx: Context): { hasActiveWork: () => boolean } {
  const quotaKinds = new WeakMap<Agent, 'waiting-quota' | 'weekly-exhausted'>()

  const append = (agent: Agent, state: Omit<PersistState, 'updatedAt'>): PersistState => {
    const next: PersistState = { ...state, updatedAt: Date.now() }
    agent.session.append('persist/change', {
      kind: 'persist/change',
      version: PERSIST_CHANGE_VERSION,
      ...next,
    })
    return next
  }

  const stateOf = (agent: Agent): PersistState | undefined => foldPersistState(agent.session.events)

  const setState = (agent: Agent, patch: Partial<Omit<PersistState, 'updatedAt'>>): PersistState => {
    const current = stateOf(agent)
    const base: Omit<PersistState, 'updatedAt'> = current === undefined
      ? { ...EMPTY_STATE }
      : {
          phase: current.phase,
          objective: current.objective,
          plan: current.plan,
          questions: current.questions,
          addendum: current.addendum,
          lastAnswer: current.lastAnswer,
          reason: current.reason,
        }
    const next = { ...base, ...patch }
    return append(agent, next)
  }

  const submitPlanning = (invocation: CommandInvocation, prompt: string): void => {
    const content = invocation.attachments.length === 0
      ? [{ type: 'text' as const, text: prompt }]
      : [...invocation.attachments, { type: 'text' as const, text: prompt }]
    invocation.agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  }

  const execute = (invocation: CommandInvocation): CommandResult => {
    if (invocation.signal.aborted) return { kind: 'error', text: 'The /persist request was cancelled.' }
    const command = parsePersistCommand(invocation.rawInput)
    if (invocation.attachments.length > 0 && !['start', 'answer'].includes(command.kind)) {
      return { kind: 'error', text: 'Attachments are only accepted with /persist <objective> or /persist answer <text>.' }
    }
    const agent = invocation.agent
    const current = stateOf(agent)
    const goals = goalsOf(ctx)

    try {
      switch (command.kind) {
        case 'show':
          return renderState(current)
        case 'invalid':
          return { kind: 'error', text: command.message }
        case 'start': {
          if (current !== undefined && !['complete', 'stopped', 'failed'].includes(current.phase)) {
            return { kind: 'error', text: `A persistent task is already ${phaseLabel(current.phase)}. Run /persist to inspect it, /persist answer <text> to refine it, or /persist stop first.` }
          }
          const objective = bounded(command.objective, PERSIST_PLAN_MAX_CHARS)
          const next = append(agent, {
            phase: 'planning',
            objective,
            plan: null,
            questions: null,
            addendum: null,
            lastAnswer: null,
            reason: null,
          })
          quotaKinds.delete(agent)
          try {
            submitPlanning(invocation, plannerPrompt(next.objective))
          } catch (error: unknown) {
            append(agent, { ...next, phase: 'failed', reason: bounded(`Could not start planning: ${errorText(error)}`, PERSIST_REASON_MAX_CHARS) })
            return { kind: 'error', text: `Could not start planning: ${errorText(error)}` }
          }
          return { kind: 'success', text: 'Persist planning started. The agent will research safely, list pain points and produce a complete plan. No implementation starts before /persist confirm.' }
        }
        case 'answer': {
          if (current === undefined || !['planning', 'needs-input', 'awaiting-confirmation'].includes(current.phase)) {
            return { kind: 'error', text: `There is no planning question to answer. ${USAGE}` }
          }
          const next = setState(agent, {
            phase: 'planning',
            lastAnswer: bounded(command.answer, PERSIST_QUESTIONS_MAX_CHARS),
            questions: null,
            addendum: null,
            reason: null,
          })
          try {
            submitPlanning(invocation, plannerPrompt(next.objective, command.answer))
          } catch (error: unknown) {
            append(agent, { ...next, phase: 'failed', reason: bounded(`Could not submit the answer: ${errorText(error)}`, PERSIST_REASON_MAX_CHARS) })
            return { kind: 'error', text: `Could not submit the answer: ${errorText(error)}` }
          }
          return { kind: 'success', text: 'Answer recorded. The agent will revise the plan and ask only remaining questions.' }
        }
        case 'confirm': {
          if (current === undefined || current.plan === null) return { kind: 'error', text: `A complete plan is required before confirmation. ${USAGE}` }
          if (current.questions !== null) return { kind: 'error', text: 'The plan still has unanswered questions. Use /persist answer <text>; implementation remains locked.' }
          if (current.phase === 'running' || current.phase === 'waiting-quota') return { kind: 'success', text: 'This persistent task is already running.' }
          if (current.phase === 'complete') return { kind: 'success', text: 'This persistent task is already complete.' }
          if (current.phase === 'weekly-exhausted') return { kind: 'error', text: 'Weekly quota is exhausted. Switch the account/provider explicitly, then run /persist resume; /persist confirm will not bypass this stop.' }
          if (goals === undefined) return { kind: 'error', text: 'The Harness goal service is not available. Install/enable the official goal plugin before confirming.' }
          const approvedPlan = current.addendum === null
            ? current.plan
            : `${current.plan}\n\nApproved addendum:\n${current.addendum}`
          const running = append(agent, {
            ...current,
            phase: 'running',
            plan: approvedPlan,
            addendum: null,
            reason: null,
          })
          quotaKinds.delete(agent)
          try {
            // Inject the approved plan as non-waking context. GoalService then
            // queues the first round; no competing ordinary follow-up is sent.
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: executionPrompt(running) }],
              source: { kind: 'plugin', plugin: 'dsh-codex-connect', form: 'instructions' },
            }))
            const existing = goals.get(agent)
            if (existing === undefined || existing.phase === 'complete') {
              goals.create(agent, {
                objective: running.objective,
                maxGoalRounds: PERSIST_DEFAULT_MAX_GOAL_ROUNDS,
              })
            } else {
              goals.resume(agent, goalRef(existing))
            }
          } catch (error: unknown) {
            append(agent, { ...running, phase: 'failed', reason: bounded(`Could not arm execution: ${errorText(error)}`, PERSIST_REASON_MAX_CHARS) })
            return { kind: 'error', text: `Could not arm execution: ${errorText(error)}` }
          }
          return { kind: 'success', text: `Plan confirmed. Continuous execution is armed for up to ${PERSIST_DEFAULT_MAX_GOAL_ROUNDS} verified rounds; use /persist pause or /persist stop at any time.` }
        }
        case 'pause': {
          if (current === undefined) return { kind: 'success', text: `No persistent task is set.\n${USAGE}` }
          if (goals !== undefined) {
            const goal = goals.get(agent)
            if (goal !== undefined && goal.phase === 'active') goals.pause(agent, goalRef(goal))
          }
          return renderState(setState(agent, { phase: 'paused', reason: 'Paused by the user.' }))
        }
        case 'resume': {
          if (current === undefined) return { kind: 'error', text: `No persistent task is set. ${USAGE}` }
          if (current.plan === null) {
            if (current.phase !== 'paused' && current.phase !== 'failed') {
              return { kind: 'error', text: 'Planning is not complete yet. Answer the questions before resuming.' }
            }
            const planning = setState(agent, { phase: 'planning', reason: null })
            try {
              submitPlanning(invocation, plannerPrompt(planning.objective, planning.lastAnswer ?? undefined))
            } catch (error: unknown) {
              setState(agent, { phase: 'failed', reason: bounded(`Could not resume planning: ${errorText(error)}`, PERSIST_REASON_MAX_CHARS) })
              return { kind: 'error', text: `Could not resume planning: ${errorText(error)}` }
            }
            return { kind: 'success', text: 'Planning resumed. Implementation remains locked until the revised plan is confirmed.' }
          }
          if (goals === undefined) return { kind: 'error', text: 'The Harness goal service is not available.' }
          const goal = goals.get(agent)
          if (goal === undefined) return { kind: 'success', text: 'The plan is ready. Review it and run /persist confirm to start execution.' }
          quotaKinds.delete(agent)
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: executionPrompt(current) }],
            source: { kind: 'plugin', plugin: 'dsh-codex-connect', form: 'instructions' },
          }))
          goals.resume(agent, goalRef(goal))
          setState(agent, { phase: 'running', reason: null })
          return { kind: 'success', text: 'Persistent execution resumed.' }
        }
        case 'stop': {
          if (goals !== undefined) {
            const goal = goals.get(agent)
            if (goal !== undefined) goals.clear(agent, goalRef(goal))
          }
          return renderState(setState(agent, {
            phase: 'stopped',
            addendum: null,
            reason: 'Stopped by the user. The session log and plan are retained for review.',
          }))
        }
      }
    } catch (error: unknown) {
      if (error instanceof GoalError) return { kind: 'error', text: `Persistent goal transition failed: ${error.message}` }
      throw error
    }
  }

  // The native command palette discovers this registration through the same
  // registry as /goal, /plan and /model.
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'persist',
      description: 'plan, confirm and continuously execute a task',
      input: { hint: '<objective> | confirm | answer <text> | pause | resume | stop', images: true },
      handler: execute,
    })
  })

  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    const current = stateOf(agent)
    if (current !== undefined && ['running', 'waiting-quota'].includes(current.phase) && quotaLike(failure)) {
      const kind = weeklyLike(failure) ? 'weekly-exhausted' : 'waiting-quota'
      quotaKinds.set(agent, kind)
      setState(agent, {
        phase: kind,
        reason: bounded(failure.message, PERSIST_REASON_MAX_CHARS),
      })
    }
    return next()
  })

  ctx.on('agent/error', ({ agent, error }) => {
    const current = stateOf(agent)
    if (current === undefined || !['planning', 'needs-input', 'awaiting-confirmation', 'running', 'waiting-quota'].includes(current.phase)) return
    if (quotaKinds.has(agent) || quotaLike(error)) return
    setState(agent, {
      phase: 'failed',
      reason: bounded(errorText(error), PERSIST_REASON_MAX_CHARS),
    })
  })

  // Goal activation is process-local by design. On a Harness restart a
  // restored active goal is disarmed first; re-arm it only for a confirmed
  // persist run, after all session-start listeners have settled. The plan is
  // injected again because an unadmitted inbox context cannot be assumed to
  // have survived the process boundary.
  ctx.on('agent/session-start', ({ agent }) => {
    void Promise.resolve().then(() => {
      const current = stateOf(agent)
      if (current === undefined || !['running', 'waiting-quota'].includes(current.phase)) return
      const goals = goalsOf(ctx)
      if (goals === undefined) return
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'active' || goal.activation === 'armed') return
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: executionPrompt(current) }],
          source: { kind: 'plugin', plugin: 'dsh-codex-connect', form: 'instructions' },
        }))
        goals.resume(agent, goalRef(goal))
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-codex-connect: could not re-arm persist after session restore: ${errorText(error)}`)
      }
    })
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const current = stateOf(agent)
    if (current === undefined) return
    if (event.type === 'assistant/message') {
      // Session.append deliberately rejects re-entrant appends while it is
      // publishing an event. Defer all workflow mutations until the current
      // publication boundary has closed, and ignore a response if a command
      // changed the state in the meantime.
      const phaseAtEvent = current.phase
      const stateSignatureAtEvent = JSON.stringify(current)
      const text = assistantText(event.data.message)
      queueMicrotask(() => {
        const latest = stateOf(agent)
        if (latest === undefined || JSON.stringify(latest) !== stateSignatureAtEvent) return
        quotaKinds.delete(agent)
        if (phaseAtEvent === 'planning' || phaseAtEvent === 'needs-input' || phaseAtEvent === 'awaiting-confirmation') {
          const plan = parsePersistPlan(text)
          if (plan !== undefined) {
            setState(agent, {
              phase: plan.questions === null ? 'awaiting-confirmation' : 'needs-input',
              plan: plan.plan,
              questions: plan.questions,
              addendum: null,
              reason: null,
            })
          }
          return
        }
        if (phaseAtEvent === 'running' || phaseAtEvent === 'waiting-quota') {
          const signals = parsePersistExecutionSignals(text)
          if (signals.addendum !== null) {
            const goals = goalsOf(ctx)
            const goal = goals?.get(agent)
            if (goal !== undefined && goal.phase === 'active') {
              try { goals?.pause(agent, goalRef(goal)) } catch (error: unknown) { ctx.logger.warn(`dsh-codex-connect: could not pause for persist addendum: ${errorText(error)}`) }
            }
            setState(agent, { phase: 'awaiting-confirmation', addendum: signals.addendum, reason: 'An unapproved scope addendum is waiting for your confirmation.' })
          } else if (signals.done) {
            const goals = goalsOf(ctx)
            const goal = goals?.get(agent)
            if (goal !== undefined && goal.phase !== 'complete') {
              try { goals?.complete(agent, goalRef(goal)) } catch (error: unknown) { ctx.logger.warn(`dsh-codex-connect: could not complete persist goal: ${errorText(error)}`) }
            }
            setState(agent, { phase: 'complete', reason: 'The agent reported completion and verification.' })
          } else if (phaseAtEvent === 'waiting-quota') {
            // A successful assistant message after the recovery wait means the
            // same account resumed normally.
            setState(agent, { phase: 'running', reason: null })
          }
        }
      })
      return
    }
    if (event.type === 'persist/change') return
  })

  ctx.on('goal/changed', ({ agent, change }) => {
    const current = stateOf(agent)
    if (current === undefined || !['running', 'waiting-quota'].includes(current.phase)) return
    if (change.goal?.phase === 'complete') {
      setState(agent, { phase: 'complete', reason: 'The Harness goal was marked complete.' })
    } else if (change.goal?.phase === 'blocked') {
      setState(agent, {
        phase: 'paused',
        reason: change.goal.blockedReason === undefined
          ? 'The Harness goal was blocked.'
          : `${change.goal.blockedReason.code}: ${change.goal.blockedReason.message}`,
      })
    }
  })

  return {
    hasActiveWork: () => {
      try {
        return ctx.agents.list().some(agent => {
          const phase = stateOf(agent)?.phase
          return phase === 'running' || phase === 'waiting-quota'
        })
      } catch {
        return false
      }
    },
  }
}
