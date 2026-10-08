import { describe, expect, it } from 'vitest'
import { AppError } from '@/lib/api/errors'
import {
  NEXT_STAGE,
  STAGE_STATUS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
  retryDelaySeconds,
  stageFromReason,
} from '@/server/pipeline/transitions'
import { RECORD_STATUSES } from '@/types/domain'

describe('record state machine (spec 00 section 4)', () => {
  it('defines a transition list for every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...RECORD_STATUSES].sort())
  })

  it('walks the happy path through every stage to auto-commit', () => {
    const path = ['received', 'consent_check', 'normalizing', 'extracting', 'mapping', 'validating', 'scoring', 'routing', 'auto_committed'] as const
    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index]
      const to = path[index + 1]
      if (from && to) expect(canTransition(from, to)).toBe(true)
    }
  })

  it('allows the review path and blocks shortcuts', () => {
    expect(canTransition('routing', 'needs_review')).toBe(true)
    expect(canTransition('needs_review', 'in_review')).toBe(true)
    expect(canTransition('in_review', 'committed')).toBe(true)
    expect(canTransition('in_review', 'needs_review')).toBe(true)
    expect(canTransition('received', 'auto_committed')).toBe(false)
    expect(canTransition('extracting', 'committed')).toBe(false)
    expect(canTransition('consent_check', 'needs_review')).toBe(false)
  })

  it('has no way out of a terminal status', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(TRANSITIONS[status]).toEqual([])
      expect(isTerminal(status)).toBe(true)
    }
    expect(isTerminal('needs_review')).toBe(false)
  })

  it('throws INVALID_TRANSITION for disallowed moves but treats a no-op as fine', () => {
    expect(() => assertTransition('received', 'committed')).toThrow(AppError)
    try {
      assertTransition('committed', 'extracting')
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_TRANSITION')
    }
    expect(() => assertTransition('mapping', 'mapping')).not.toThrow()
  })

  it('lets a retry leave failed or needs_review only', () => {
    expect(() => assertTransition('failed', 'extracting', { retry: true })).not.toThrow()
    expect(() => assertTransition('needs_review', 'normalizing', { retry: true })).not.toThrow()
    expect(() => assertTransition('committed', 'extracting', { retry: true })).toThrow(AppError)
    expect(() => assertTransition('blocked_consent', 'normalizing', { retry: true })).toThrow(AppError)
    expect(() => assertTransition('failed', 'extracting')).toThrow(AppError)
  })
})

describe('stage helpers', () => {
  it('chains the stages in order and ends at commit', () => {
    expect(NEXT_STAGE.consent_check).toBe('normalize')
    expect(NEXT_STAGE.route).toBe('commit')
    expect(NEXT_STAGE.commit).toBeNull()
  })

  it('maps each stage to the status shown while it runs', () => {
    expect(STAGE_STATUS.normalize).toBe('normalizing')
    expect(STAGE_STATUS.commit).toBe('routing')
  })

  it('backs off linearly: 15 seconds times the attempt', () => {
    expect(retryDelaySeconds(1)).toBe(15)
    expect(retryDelaySeconds(2)).toBe(30)
    expect(retryDelaySeconds(0)).toBe(15)
  })

  it('reads the stage out of a stage_error reason', () => {
    expect(stageFromReason('stage_error:extract')).toBe('extract')
    expect(stageFromReason('stage_error:nonsense')).toBeNull()
    expect(stageFromReason('llm_error')).toBeNull()
    expect(stageFromReason(null)).toBeNull()
  })
})
