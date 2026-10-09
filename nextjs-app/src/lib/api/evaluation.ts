import { apiFetch } from '@/lib/api/client'
import type { EvalBasis, EvaluationView } from '@/types/evaluation'

export async function fetchEvaluation(sourceId: string, days: number | null): Promise<EvaluationView> {
  const query = days === null ? '' : `?days=${days}`
  return (await apiFetch<EvaluationView>(`/api/sources/${sourceId}/evaluation${query}`)).data
}

export async function runSourceEvaluation(sourceId: string, basis: EvalBasis, note?: string): Promise<EvaluationView> {
  return (await apiFetch<EvaluationView>(`/api/sources/${sourceId}/run-eval`, { method: 'POST', body: JSON.stringify({ basis, ...(note ? { note } : {}) }) })).data
}
