import type { ReviewDecision } from '@/lib/validation/review'
import type { CodeSystem } from '@/types/domain'
import type { ReviewAction, WorkspaceField, WorkspaceResource } from '@/types/review'

/** A reviewer's decision on one field while the review is still open. */
export interface DraftDecision {
  action: ReviewAction
  /** The corrected text or number, as typed. */
  value?: string
  code?: { system: CodeSystem; code: string; display: string }
  note?: string
}

/** Decisions by field key. Fields with no entry are accepted as they are unless they need a decision. */
export type Draft = Record<string, DraftDecision>

export interface DecisionCounts {
  accepted: number
  corrected: number
  rejected: number
  /** Fields that need a decision and have none yet. */
  pending: number
}

export const allFields = (resources: readonly WorkspaceResource[]): WorkspaceField[] => resources.flatMap((resource) => resource.fields)

export function countDecisions(resources: readonly WorkspaceResource[], draft: Draft): DecisionCounts {
  const counts: DecisionCounts = { accepted: 0, corrected: 0, rejected: 0, pending: 0 }
  for (const field of allFields(resources)) {
    const decision = draft[field.field_key]
    if (!decision) {
      if (field.needs_decision) counts.pending += 1
      else counts.accepted += 1
      continue
    }
    if (decision.action === 'accept') counts.accepted += 1
    else if (decision.action === 'correct') counts.corrected += 1
    else counts.rejected += 1
  }
  return counts
}

/** Problems visible without asking the server: an empty correction, or rejecting a required value. */
export function localIssues(resources: readonly WorkspaceResource[], draft: Draft): Record<string, string> {
  const issues: Record<string, string> = {}
  for (const field of allFields(resources)) {
    const decision = draft[field.field_key]
    if (!decision) continue
    if (decision.action === 'correct' && !decision.value?.trim() && !decision.code) {
      issues[field.field_key] = 'Enter a value or choose a code.'
    }
    if (decision.action === 'accept' && !field.found && field.required) {
      issues[field.field_key] = 'This required value is missing. Enter it, or reject the record.'
    }
    if (decision.action === 'reject' && field.required) {
      issues[field.field_key] = 'A required value cannot be rejected. Correct it, or reject the record.'
    }
  }
  return issues
}

/** Approval needs every required decision made and no local problems, and something to commit. */
export function canApprove(resources: readonly WorkspaceResource[], draft: Draft): boolean {
  if (resources.length === 0) return false
  return countDecisions(resources, draft).pending === 0 && Object.keys(localIssues(resources, draft)).length === 0
}

/** The explicit decisions to send (implicit accepts are filled in by the server). */
export function toSubmitDecisions(resources: readonly WorkspaceResource[], draft: Draft): ReviewDecision[] {
  const known = new Set(allFields(resources).map((field) => field.field_key))
  return Object.entries(draft)
    .filter(([key]) => known.has(key))
    .map(([field_key, decision]) => ({
      field_key,
      action: decision.action,
      ...(decision.action === 'correct' && decision.value?.trim() ? { value: decision.value.trim() } : {}),
      ...(decision.action === 'correct' && decision.code ? { code: { system: decision.code.system, code: decision.code.code } } : {}),
      ...(decision.note?.trim() ? { note: decision.note.trim() } : {}),
    }))
}

const storageKey = (taskId: string) => `review-draft:${taskId}`

/** Draft decisions survive a reload or an expired hold. Only field keys and values already on screen are stored. */
export function loadDraft(taskId: string): Draft {
  try {
    const raw = window.sessionStorage.getItem(storageKey(taskId))
    return raw ? (JSON.parse(raw) as Draft) : {}
  } catch {
    return {}
  }
}

export function saveDraft(taskId: string, draft: Draft): void {
  try {
    if (Object.keys(draft).length === 0) window.sessionStorage.removeItem(storageKey(taskId))
    else window.sessionStorage.setItem(storageKey(taskId), JSON.stringify(draft))
  } catch {
    // Storage can be unavailable (private windows); the draft then lives in memory only.
  }
}

export function clearDraft(taskId: string): void {
  saveDraft(taskId, {})
}
