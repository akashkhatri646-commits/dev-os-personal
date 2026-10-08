import { apiFetch } from '@/lib/api/client'
import type { DashboardData } from '@/types/metrics'

export async function fetchDashboard(days: 7 | 30 | 90): Promise<DashboardData> {
  return (await apiFetch<DashboardData>(`/api/metrics/sources?days=${days}`)).data
}
