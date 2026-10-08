import type { ConsentArtifact, ConsentVerdict } from '@/types/consent'

const time = (iso: string) => new Date(iso).getTime()

/**
 * The consent matching rules (docs/specs/05-consent-gate.md §3). A pure function of the patient's
 * artifacts and the evaluation time: deterministic, no model involved, identical for every ledger.
 *
 * - No artifacts: `missing`.
 * - Artifacts exist but none is currently valid: `revoked` if the most recently created one was
 *   revoked, `expired` if any has run out, otherwise `missing` (all start in the future).
 * - Among valid artifacts, ONE artifact must cover every required category. Artifacts are never
 *   combined ("stitched"): otherwise `out_of_scope`.
 * - The artifact with the latest `valid_to` (then latest creation) is reported as the match.
 * - An artifact is valid up to and including its `valid_to` instant.
 */
export function evaluateConsent(
  artifacts: readonly ConsentArtifact[],
  requiredCategories: readonly string[],
  at: Date,
): ConsentVerdict {
  const now = at.getTime()
  const required = [...new Set(requiredCategories)]
  const baseDetail = { artifacts: artifacts.length }

  // Nothing to match against is a malformed request, never an implicit allow.
  if (required.length === 0) {
    return { result: 'out_of_scope', matchedScope: [], detail: { ...baseDetail, reason: 'no_categories_requested' } }
  }
  if (artifacts.length === 0) {
    return { result: 'missing', matchedScope: [], detail: baseDetail }
  }

  const active = artifacts.filter(
    (artifact) =>
      artifact.status === 'granted' && time(artifact.valid_from) <= now && now <= time(artifact.valid_to),
  )

  if (active.length === 0) {
    const latest = [...artifacts].sort((a, b) => time(b.created_at) - time(a.created_at))[0]
    if (latest?.status === 'revoked') {
      return { result: 'revoked', matchedScope: [], detail: { ...baseDetail, active: 0 } }
    }
    const anyExpired = artifacts.some((artifact) => artifact.status === 'expired' || time(artifact.valid_to) < now)
    return { result: anyExpired ? 'expired' : 'missing', matchedScope: [], detail: { ...baseDetail, active: 0 } }
  }

  const covering = active.filter((artifact) => required.every((category) => artifact.categories.includes(category)))
  if (covering.length === 0) {
    return { result: 'out_of_scope', matchedScope: [], detail: { ...baseDetail, active: active.length } }
  }

  const match = [...covering].sort(
    (a, b) => time(b.valid_to) - time(a.valid_to) || time(b.created_at) - time(a.created_at),
  )[0]
  if (!match) return { result: 'error', matchedScope: [], detail: { ...baseDetail, reason: 'no_match_selected' } }

  return {
    result: 'valid',
    artifactId: match.id,
    artifactRef: match.artifact_ref,
    matchedScope: [...required].sort(),
    detail: { ...baseDetail, active: active.length },
  }
}
