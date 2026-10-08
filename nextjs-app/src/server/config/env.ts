import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'

/** Treat empty strings (as left in .env files) as "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const requiredString = () => z.preprocess(blankToUndefined, z.string().min(1))
const optionalString = (min = 1) =>
  z.preprocess(blankToUndefined, z.string().min(min).optional())
const numberWithDefault = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().finite().default(fallback))
const optionalNumber = () =>
  z.preprocess(blankToUndefined, z.coerce.number().finite().optional())
const booleanWithDefault = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),
  )

const envSchema = z.object({
  // App
  APP_BASE_URL: z.preprocess(blankToUndefined, z.url().default('http://localhost:3000')),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ),

  // Supabase (required: nothing works without them)
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(blankToUndefined, z.url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: requiredString(),
  SUPABASE_SERVICE_ROLE_KEY: requiredString(),
  SUPABASE_STORAGE_BUCKET: z.preprocess(
    blankToUndefined,
    z.string().min(1).default('source-documents'),
  ),

  // LLM
  LLM_PROVIDER: z.preprocess(blankToUndefined, z.enum(['openai', 'azure_openai']).optional()),
  OPENAI_API_KEY: optionalString(),
  AZURE_OPENAI_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  AZURE_OPENAI_API_KEY: optionalString(),
  AZURE_OPENAI_API_VERSION: optionalString(),
  EMBEDDINGS_MODEL: optionalString(),
  LLM_MODEL_EXTRACTION: optionalString(),
  LLM_MODEL_LIGHT: optionalString(),
  LLM_MAX_INPUT_TOKENS: numberWithDefault(150_000),
  LLM_MAX_OUTPUT_TOKENS: numberWithDefault(8_000),
  LLM_REQUEST_TIMEOUT_MS: numberWithDefault(60_000),
  LLM_PRICE_INPUT_PER_MTOK: optionalNumber(),
  LLM_PRICE_OUTPUT_PER_MTOK: optionalNumber(),
  LLM_DAILY_BUDGET_USD: numberWithDefault(200),
  LLM_MAX_CONCURRENCY_PER_SOURCE: numberWithDefault(3),

  // OCR
  OCR_PROVIDER: z.preprocess(blankToUndefined, z.enum(['textract', 'documentai']).optional()),
  OCR_CONFIDENCE_FLOOR: numberWithDefault(0.8),
  OCR_MAX_PAGES: numberWithDefault(40),

  // FHIR validation
  FHIR_VALIDATOR_MODE: z.preprocess(blankToUndefined, z.enum(['node', 'service']).default('node')),
  FHIR_VALIDATOR_URL: z.preprocess(blankToUndefined, z.url().optional()),

  // Consent
  CONSENT_MODE: z.preprocess(blankToUndefined, z.enum(['stub', 'abdm']).default('stub')),

  // Pipeline / worker
  WORKER_SECRET: optionalString(32),
  WORKER_BATCH_SIZE: numberWithDefault(5),
  WORKER_TICK_MAX_SECONDS: numberWithDefault(50),
  // Hard time limit of the host for one worker call (Netlify web routes: 60). Leave unset locally.
  WORKER_HOST_LIMIT_SECONDS: optionalNumber(),
  JOB_MAX_ATTEMPTS: numberWithDefault(2),
  HOLDBACK_PCT_DEFAULT: numberWithDefault(10),
  DEFAULT_THRESHOLD: numberWithDefault(0.97),
  MEDICATION_ALLERGY_THRESHOLD: numberWithDefault(0.99),
  REVIEW_LOCK_MINUTES: numberWithDefault(30),
  ENABLED_DOC_TYPES: z.preprocess(
    blankToUndefined,
    z
      .string()
      .default('discharge_summary')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
  ),
  // Fails closed: anything other than the literal "true" disables auto-commit.
  SYSTEM_AUTOCOMMIT_ENABLED: z.preprocess((value) => (typeof value === 'string' ? value.trim().toLowerCase() === 'true' : false), z.boolean()),
  REVIEWER_COST_PER_MIN: optionalNumber(),

  // Security / PHI protection
  PATIENT_ID_HMAC_KEY: optionalString(32),
  PATIENT_ID_ENC_KEY: optionalString(32),
  SOURCE_KEY_PEPPER: optionalString(16),
  SIGNED_URL_TTL_SECONDS: numberWithDefault(300),
  MAX_UPLOAD_BYTES: numberWithDefault(26_214_400),

  // Rate limiting
  RATE_LIMIT_USER_PER_MIN: numberWithDefault(60),
  RATE_LIMIT_SOURCE_KEY_PER_MIN: numberWithDefault(120),

  // Alerts
  ALERT_WEBHOOK_URL: z.preprocess(blankToUndefined, z.url().optional()),
  ALERT_STP_DELTA_POINTS: numberWithDefault(5),
  ALERT_ESCALATION_PRECISION_MIN: numberWithDefault(0.6),
  ALERT_CORRECTION_RATE_MAX: numberWithDefault(0.01),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/**
 * Validated server configuration. Parsed on first use and cached; throws a descriptive
 * error listing every invalid variable so misconfiguration fails fast and visibly.
 */
export function getEnv(): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid server environment: ${problems}`)
  }
  cached = parsed.data
  return cached
}

/**
 * Returns a value that is optional at boot but mandatory for a specific feature
 * (e.g. PATIENT_ID_HMAC_KEY for ingestion). Throws a non-retryable INTERNAL error naming the variable.
 */
export function requireEnvValue<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = getEnv()[key]
  if (value === undefined || value === null || value === '') {
    throw new AppError('INTERNAL', `Missing required configuration: ${String(key)}`, {
      retryable: false,
    })
  }
  return value as NonNullable<Env[K]>
}
