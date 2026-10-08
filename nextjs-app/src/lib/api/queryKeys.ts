// Central TanStack Query keys. Features append their own entries here as they are built.

export const queryKeys = {
  me: ['me'] as const,
  users: ['users'] as const,
  systemCheck: ['system-check'] as const,
  sources: ['sources'] as const,
  // A plain list for dropdowns. It must not share a key with `sources` (an infinite query): the cached shapes differ.
  // Invalidating `sources` still refreshes it, because the keys share a prefix.
  sourceOptions: ['sources', 'options'] as const,
  records: ['records'] as const,
  consentArtifacts: ['consent-artifacts'] as const,
  audit: (filters: unknown) => ['audit', filters] as const,
  source: (id: string) => ['source', id] as const,
  thresholdHistory: (id: string) => ['source', id, 'threshold-history'] as const,
  reviewTasks: (filters: unknown) => ['review-tasks', filters] as const,
  reviewWorkspace: (taskId: string) => ['review-workspace', taskId] as const,
  recordDetail: (id: string) => ['record', id] as const,
  recordTrace: (id: string) => ['record', id, 'trace'] as const,
  reconstruction: (id: string) => ['record', id, 'reconstruction'] as const,
  recordsList: (filters: unknown) => ['records', 'list', filters] as const,
  incidents: (status: string) => ['incidents', status] as const,
  dashboard: (days: number) => ['dashboard', days] as const,
  health: ['health'] as const,
} as const
