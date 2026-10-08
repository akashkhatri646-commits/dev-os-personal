import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { BUILTIN_EXTRACTION_PROMPT, type FewShotExample } from '@/server/services/extraction/prompt'
import { BUILTIN_MAPPING_PROMPT } from '@/server/services/mapping/prompt'

const UNIQUE_VIOLATION = '23505'

export interface ActivePrompt {
  id: string
  version: string
  template: string
  fewShot: FewShotExample[]
  modelId: string
}

const rowSchema = z.object({
  id: z.string(),
  version: z.string(),
  template: z.string(),
  few_shot: z.array(z.object({ user: z.string(), assistant: z.string() })),
  model_id: z.string(),
})

const COLUMNS = 'id, version, template, few_shot, model_id'

type PromptComponent = 'extraction' | 'mapping'

interface BuiltinPrompt {
  version: string
  template: string
  few_shot: FewShotExample[]
}

async function selectActive(component: PromptComponent) {
  const { data, error } = await getSupabaseAdmin()
    .from('prompt_versions')
    .select(COLUMNS)
    .eq('component', component)
    .eq('active', true)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', `Failed to load the ${component} prompt.`, { cause: error, retryable: true })
  return data ? rowSchema.parse(data) : null
}

function toActivePrompt(row: z.infer<typeof rowSchema>): ActivePrompt {
  return { id: row.id, version: row.version, template: row.template, fewShot: row.few_shot, modelId: row.model_id }
}

/**
 * The active prompt for a component (the database is the source of truth, so a newer version can be
 * activated without a deploy). The first time a component runs, its built-in version is stored and
 * activated. At most one version is active (unique index), so a concurrent first run is harmless.
 */
async function getActivePrompt(component: PromptComponent, builtin: BuiltinPrompt, modelId: string): Promise<ActivePrompt> {
  const existing = await selectActive(component)
  if (existing) return toActivePrompt(existing)

  const { error } = await getSupabaseAdmin().from('prompt_versions').insert({
    component,
    version: builtin.version,
    template: builtin.template,
    few_shot: builtin.few_shot,
    model_id: modelId,
    active: true,
  })
  if (error && error.code !== UNIQUE_VIOLATION) {
    throw new AppError('INTERNAL', `Failed to store the built-in ${component} prompt.`, { cause: error, retryable: true })
  }
  const created = await selectActive(component)
  if (!created) throw new AppError('INTERNAL', `No active ${component} prompt is available.`, { retryable: true })
  return toActivePrompt(created)
}

export const getActiveExtractionPrompt = (modelId: string) => getActivePrompt('extraction', BUILTIN_EXTRACTION_PROMPT, modelId)
export const getActiveMappingPrompt = (modelId: string) => getActivePrompt('mapping', BUILTIN_MAPPING_PROMPT, modelId)
