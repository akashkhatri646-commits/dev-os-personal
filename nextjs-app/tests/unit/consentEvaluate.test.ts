import { describe, expect, it } from 'vitest'
import { evaluateConsent } from '@/server/services/consent/evaluate'
import type { ConsentArtifact } from '@/types/consent'

const NOW = new Date('2026-10-07T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString()

let counter = 0
function artifact(overrides: Partial<ConsentArtifact> = {}): ConsentArtifact {
  counter += 1
  return {
    id: `artifact-${counter}`,
    artifact_ref: `ref-${counter}`,
    categories: ['DischargeSummary'],
    valid_from: iso(-10),
    valid_to: iso(10),
    status: 'granted',
    created_at: iso(-10 + counter / 100),
    ...overrides,
  }
}

const REQUIRED = ['DischargeSummary']

describe('evaluateConsent: allow path', () => {
  it('returns valid with the artifact, its reference and the matched scope', () => {
    const match = artifact({ categories: ['DischargeSummary', 'Prescription'] })
    const verdict = evaluateConsent([match], ['DischargeSummary', 'Prescription'], NOW)
    expect(verdict.result).toBe('valid')
    expect(verdict.artifactId).toBe(match.id)
    expect(verdict.artifactRef).toBe(match.artifact_ref)
    expect(verdict.matchedScope).toEqual(['DischargeSummary', 'Prescription'])
  })

  it('allows exactly at both ends of the validity window (valid_to is inclusive)', () => {
    expect(evaluateConsent([artifact({ valid_from: NOW.toISOString(), valid_to: iso(5) })], REQUIRED, NOW).result).toBe('valid')
    expect(evaluateConsent([artifact({ valid_from: iso(-5), valid_to: NOW.toISOString() })], REQUIRED, NOW).result).toBe('valid')
  })

  it('ignores duplicate required categories', () => {
    expect(evaluateConsent([artifact()], ['DischargeSummary', 'DischargeSummary'], NOW).result).toBe('valid')
  })

  it('reports the artifact with the latest valid_to when several qualify', () => {
    const shorter = artifact({ valid_to: iso(2) })
    const longer = artifact({ valid_to: iso(20) })
    expect(evaluateConsent([shorter, longer], REQUIRED, NOW).artifactId).toBe(longer.id)
    expect(evaluateConsent([longer, shorter], REQUIRED, NOW).artifactId).toBe(longer.id)
  })

  it('breaks a valid_to tie by the most recently created artifact', () => {
    const older = artifact({ valid_to: iso(5), created_at: iso(-3) })
    const newer = artifact({ valid_to: iso(5), created_at: iso(-1) })
    expect(evaluateConsent([older, newer], REQUIRED, NOW).artifactId).toBe(newer.id)
  })
})

describe('evaluateConsent: every block case', () => {
  it('missing: no artifacts at all', () => {
    expect(evaluateConsent([], REQUIRED, NOW).result).toBe('missing')
  })

  it('expired: the only artifact ended in the past', () => {
    expect(evaluateConsent([artifact({ valid_from: iso(-30), valid_to: iso(-1) })], REQUIRED, NOW).result).toBe('expired')
  })

  it('expired: one millisecond after valid_to', () => {
    const justEnded = artifact({ valid_from: iso(-30), valid_to: new Date(NOW.getTime() - 1).toISOString() })
    expect(evaluateConsent([justEnded], REQUIRED, NOW).result).toBe('expired')
  })

  it('expired: an explicit expired status', () => {
    expect(evaluateConsent([artifact({ status: 'expired' })], REQUIRED, NOW).result).toBe('expired')
  })

  it('revoked: a revoked artifact that is otherwise in date', () => {
    expect(evaluateConsent([artifact({ status: 'revoked' })], REQUIRED, NOW).result).toBe('revoked')
  })

  it('revoked: the latest artifact is revoked and nothing else is valid', () => {
    const old = artifact({ valid_to: iso(-2), created_at: iso(-20) })
    const revoked = artifact({ status: 'revoked', created_at: iso(-1) })
    expect(evaluateConsent([old, revoked], REQUIRED, NOW).result).toBe('revoked')
  })

  it('missing: the only artifact has not started yet', () => {
    expect(evaluateConsent([artifact({ valid_from: iso(2), valid_to: iso(30) })], REQUIRED, NOW).result).toBe('missing')
  })

  it('out_of_scope: a valid artifact that does not cover the requested category', () => {
    const verdict = evaluateConsent([artifact({ categories: ['Prescription'] })], REQUIRED, NOW)
    expect(verdict.result).toBe('out_of_scope')
    expect(verdict.artifactId).toBeUndefined()
  })

  it('out_of_scope: covers only some of the requested categories', () => {
    const verdict = evaluateConsent([artifact({ categories: ['DischargeSummary'] })], ['DischargeSummary', 'Prescription'], NOW)
    expect(verdict.result).toBe('out_of_scope')
  })

  it('out_of_scope: two artifacts that each cover one category are NOT stitched together', () => {
    const a = artifact({ categories: ['DischargeSummary'] })
    const b = artifact({ categories: ['Prescription'] })
    const verdict = evaluateConsent([a, b], ['DischargeSummary', 'Prescription'], NOW)
    expect(verdict.result).toBe('out_of_scope')
  })

  it('out_of_scope: no categories requested is never an implicit allow', () => {
    const verdict = evaluateConsent([artifact()], [], NOW)
    expect(verdict.result).toBe('out_of_scope')
    expect(verdict.detail.reason).toBe('no_categories_requested')
  })

  it('does not let an expired or revoked artifact satisfy the check when it covers the scope', () => {
    const expired = artifact({ valid_from: iso(-30), valid_to: iso(-1), categories: ['DischargeSummary', 'Prescription'] })
    const narrowValid = artifact({ categories: ['DischargeSummary'] })
    expect(evaluateConsent([expired, narrowValid], ['DischargeSummary', 'Prescription'], NOW).result).toBe('out_of_scope')
  })

  it('a valid artifact still wins when a different, newer artifact was revoked', () => {
    const valid = artifact({ created_at: iso(-5) })
    const revokedOther = artifact({ status: 'revoked', created_at: iso(-1) })
    expect(evaluateConsent([valid, revokedOther], REQUIRED, NOW).result).toBe('valid')
  })
})

describe('evaluateConsent: output hygiene', () => {
  it('never puts patient data or consent references in the detail', () => {
    const match = artifact()
    const text = JSON.stringify(evaluateConsent([match], REQUIRED, NOW).detail)
    expect(text).not.toContain(match.artifact_ref)
    expect(text).not.toContain(match.id)
  })

  it('is deterministic for the same inputs', () => {
    const artifacts = [artifact(), artifact({ categories: ['Prescription'] })]
    expect(evaluateConsent(artifacts, REQUIRED, NOW)).toEqual(evaluateConsent(artifacts, REQUIRED, NOW))
  })
})
