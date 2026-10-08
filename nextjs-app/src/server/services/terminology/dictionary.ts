import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

/**
 * Brand names and abbreviations from `knowledge_docs` (title = the short form, content = what it
 * stands for), so "Crocin" is searched as "paracetamol" and "HTN" as "hypertension".
 */
export type TermDictionary = ReadonlyMap<string, string>

export async function loadTermDictionary(): Promise<TermDictionary> {
  const { data, error } = await getSupabaseAdmin().from('knowledge_docs').select('title, content').in('kind', ['drug_brand_map', 'abbreviation'])
  if (error) throw new AppError('INTERNAL', 'Failed to load the term dictionary.', { cause: error, retryable: true })
  return new Map((data ?? []).map((row) => [row.title.trim().toLowerCase(), row.content.trim()]))
}

/** The query itself plus its expansion, when the dictionary knows it. */
export function expandQuery(query: string, dictionary: TermDictionary): string[] {
  const expanded = dictionary.get(query.trim().toLowerCase())
  return expanded && expanded.toLowerCase() !== query.trim().toLowerCase() ? [query, expanded] : [query]
}
