import { describe, expect, it } from 'vitest'
import { buildPipelineSteps, formatDuration } from '@/lib/records/pipeline'
import type { RecordEvent } from '@/types/records'

const event = (name: string, at: string): RecordEvent => ({ event: name, created_at: `2026-10-07T00:${at}Z`, payload: {} })
const states = (steps: ReturnType<typeof buildPipelineSteps>) => steps.map((step) => `${step.id}:${step.state}`).join(' ')

describe('buildPipelineSteps', () => {
  it('shows a committed record as done end to end, with the time each step took', () => {
    const steps = buildPipelineSteps('auto_committed', [
      event('consent.checked', '00:00'),
      event('ocr.completed', '00:10'),
      event('extraction.completed', '01:10'),
      event('mapping.completed', '01:20'),
      event('validation.completed', '01:21'),
      event('scoring.completed', '01:22'),
      event('routing.decided', '01:23'),
      event('record.committed', '01:24'),
    ])
    expect(steps.every((step) => step.state === 'done')).toBe(true)
    expect(steps[1]?.durationMs).toBe(10_000)
    expect(steps[2]?.durationMs).toBe(60_000)
    expect(steps[0]?.durationMs).toBeNull()
  })

  it('after a re-run, shows the restarted step as current and drops the old results from there on', () => {
    const rerun: RecordEvent = { event: 'record.status_changed', created_at: '2026-10-07T00:05:00Z', payload: { from: 'needs_review', to: 'extracting', reason: 'admin_rerun' } }
    const steps = buildPipelineSteps('mapping', [
      event('consent.checked', '00:00'),
      event('ocr.completed', '00:10'),
      event('extraction.completed', '01:10'),
      event('mapping.completed', '01:20'),
      event('routing.decided', '01:23'),
      rerun,
      { ...event('extraction.completed', '06:10') },
    ])
    expect(states(steps)).toBe('consent:done ocr:done extraction:done mapping:current validation:pending scoring:pending routing:pending commit:pending')
  })

  it('marks the next step current while a record is processing, and later ones pending', () => {
    const steps = buildPipelineSteps('extracting', [event('consent.checked', '00:00'), event('ocr.completed', '00:10')])
    expect(states(steps)).toBe('consent:done ocr:done extraction:current mapping:pending validation:pending scoring:pending routing:pending commit:pending')
  })

  it('shows a record nothing has picked up yet as queued, not running', () => {
    const steps = buildPipelineSteps('received', [])
    expect(steps.every((step) => step.state === 'pending')).toBe(true)
    expect(steps[0]).toMatchObject({ id: 'consent', note: 'Queued: waiting for the worker' })
    expect(buildPipelineSteps('consent_check', [])[0]?.state).toBe('current')
  })

  it('shows an escalated record as waiting for review at the commit step', () => {
    const steps = buildPipelineSteps('needs_review', [
      event('consent.checked', '00:00'),
      event('ocr.completed', '00:10'),
      event('extraction.completed', '01:10'),
      event('mapping.completed', '01:20'),
      event('validation.completed', '01:21'),
      event('scoring.completed', '01:22'),
      event('routing.decided', '01:23'),
    ])
    expect(steps.at(-1)).toMatchObject({ id: 'commit', state: 'pending', note: 'Waiting for a reviewer' })
    expect(buildPipelineSteps('in_review', []).at(-1)?.note).toBe('A reviewer is working on it')
  })

  it('skips the steps after an early escalation', () => {
    const steps = buildPipelineSteps('needs_review', [event('consent.checked', '00:00'), event('ocr.rejected_low_quality', '00:10')])
    expect(states(steps)).toBe('consent:done ocr:skipped extraction:skipped mapping:skipped validation:skipped scoring:skipped routing:skipped commit:pending')
  })

  it('marks the first unfinished step as failed for a failed record', () => {
    const steps = buildPipelineSteps('failed', [event('consent.checked', '00:00'), event('ocr.completed', '00:10')])
    expect(states(steps)).toBe('consent:done ocr:done extraction:failed mapping:skipped validation:skipped scoring:skipped routing:skipped commit:skipped')
  })

  it('shows a consent block at the first step and skips everything after it', () => {
    const steps = buildPipelineSteps('blocked_consent', [event('consent.checked', '00:00'), event('consent.blocked', '00:00')])
    expect(steps[0]).toMatchObject({ state: 'blocked', note: 'Consent did not allow this record' })
    expect(steps.slice(1).every((step) => step.state === 'skipped')).toBe(true)
  })

  it('shows a rejected record with no commit', () => {
    expect(buildPipelineSteps('rejected', [event('consent.checked', '00:00')]).at(-1)?.state).toBe('skipped')
  })
})

describe('formatDuration', () => {
  it('formats a duration in the largest sensible unit', () => {
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(400)).toBe('<1 s')
    expect(formatDuration(12_000)).toBe('12 s')
    expect(formatDuration(180_000)).toBe('3 min')
    expect(formatDuration(5_400_000)).toBe('1.5 h')
  })
})
