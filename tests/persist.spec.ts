import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  foldPersistState,
  parsePersistCommand,
  parsePersistExecutionSignals,
  parsePersistPlan,
  PERSIST_CHANGE_VERSION,
  registerPersistCommand,
} from '../src/persist.ts'

describe('/persist command grammar', () => {
  it('treats a bare command as status and arbitrary text as a new objective', () => {
    expect(parsePersistCommand('')).toEqual({ kind: 'show' })
    expect(parsePersistCommand('  build a Reading-like web app  ')).toEqual({
      kind: 'start',
      objective: 'build a Reading-like web app',
    })
  })

  it('keeps control words distinct from objectives and requires answer text', () => {
    expect(parsePersistCommand('confirm')).toEqual({ kind: 'confirm' })
    expect(parsePersistCommand('approve')).toEqual({ kind: 'confirm' })
    expect(parsePersistCommand('continue')).toEqual({ kind: 'resume' })
    expect(parsePersistCommand('answer')).toMatchObject({ kind: 'invalid' })
    expect(parsePersistCommand('answer  what should be preserved?')).toEqual({
      kind: 'answer',
      answer: 'what should be preserved?',
    })
    expect(parsePersistCommand('confirming a feature')).toEqual({
      kind: 'start',
      objective: 'confirming a feature',
    })
  })
})

describe('persist plan envelopes', () => {
  it('parses a complete plan and normalizes NONE', () => {
    expect(parsePersistPlan([
      '[NASAGENT_PERSIST_PLAN]',
      '# Scope',
      '- inspect the existing app',
      '[NASAGENT_PERSIST_QUESTIONS]',
      'NONE',
      '[NASAGENT_PERSIST_PLAN_END]',
    ].join('\n'))).toEqual({
      plan: '# Scope\n- inspect the existing app',
      questions: null,
    })
  })

  it('does not accept a truncated or incomplete envelope', () => {
    expect(parsePersistPlan('[NASAGENT_PERSIST_PLAN]\nplan')).toBeUndefined()
    expect(parsePersistPlan([
      '[NASAGENT_PERSIST_PLAN]',
      'plan',
      '[NASAGENT_PERSIST_PLAN_END]',
    ].join('\n'))).toBeUndefined()
  })

  it('separates addenda from completion', () => {
    expect(parsePersistExecutionSignals([
      '[NASAGENT_PERSIST_ADDENDUM]',
      'Add keyboard navigation',
      '[NASAGENT_PERSIST_ADDENDUM_END]',
      '[NASAGENT_PERSIST_DONE]',
    ].join('\n'))).toEqual({ addendum: 'Add keyboard navigation', done: true })
    expect(parsePersistExecutionSignals('ordinary progress')).toEqual({ addendum: null, done: false })
  })
})

describe('persist event replay', () => {
  it('folds the last whole-value state and ignores foreign versions', () => {
    const event = (seq: number, data: unknown): SessionEvent => ({
      type: 'persist/change',
      seq,
      time: seq,
      data: data as never,
    })
    const first = {
      kind: 'persist/change',
      version: PERSIST_CHANGE_VERSION,
      phase: 'planning',
      objective: 'ship it',
      plan: null,
      questions: null,
      addendum: null,
      lastAnswer: null,
      reason: null,
      updatedAt: 1,
    } as const
    const second = { ...first, phase: 'awaiting-confirmation', plan: 'step one', updatedAt: 2 } as const
    expect(foldPersistState([event(0, { ...first, version: 99 }), event(1, first), event(2, second)]))
      .toMatchObject({ phase: 'awaiting-confirmation', plan: 'step one' })
    expect(foldPersistState([event(0, { ...first, version: 99 })])).toBeUndefined()
  })
})

describe('persist command lifecycle', () => {
  it('does not arm a goal before explicit confirmation', () => {
    const events: SessionEvent[] = []
    const session = {
      id: 'session-1',
      events,
      append(type: string, data: unknown) {
        events.push({ type: type as SessionEvent['type'], seq: events.length, time: events.length, data: data as never })
      },
    }
    const agent = {
      id: 'session-1',
      session,
      followup: vi.fn(),
      inject: vi.fn(),
    }
    const handlers = new Map<string, (invocation: unknown) => unknown>()
    const goals = {
      get: vi.fn(() => undefined),
      create: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      clear: vi.fn(),
    }
    const ctx = {
      goals,
      agents: { get: vi.fn(() => agent), list: vi.fn(() => [agent]) },
      on: vi.fn(),
      inject: vi.fn((_deps: string[], callback: (child: unknown) => void) => {
        callback({ commands: { register(definition: { name: string; handler: (invocation: unknown) => unknown }) {
          handlers.set(definition.name, definition.handler)
        } } })
      }),
    }
    registerPersistCommand(ctx as never)
    const handler = handlers.get('persist')
    if (handler === undefined) throw new Error('persist command was not registered')
    const invocation = (rawInput: string) => ({
      agent,
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    })

    expect(handler(invocation('build a small app'))).toMatchObject({ kind: 'success' })
    expect(goals.create).not.toHaveBeenCalled()
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.inject).not.toHaveBeenCalled()

    events.push({
      type: 'persist/change',
      seq: events.length,
      time: events.length,
      data: {
        kind: 'persist/change',
        version: PERSIST_CHANGE_VERSION,
        phase: 'awaiting-confirmation',
        objective: 'build a small app',
        plan: '1. implement\n2. test',
        questions: null,
        addendum: null,
        lastAnswer: null,
        reason: null,
        updatedAt: Date.now(),
      },
    })
    expect(handler(invocation('confirm'))).toMatchObject({ kind: 'success' })
    expect(goals.create).toHaveBeenCalledOnce()
    expect(agent.inject).toHaveBeenCalledOnce()
  })
})
