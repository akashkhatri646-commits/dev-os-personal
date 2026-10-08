import 'server-only'
import pino from 'pino'

/**
 * Structured JSON logger. Keys that can carry PHI or secrets are redacted wherever they appear
 * at the top level or one level deep. Log ids, enums and counts only (spec 00 §6, spec 16 §7).
 */
const SENSITIVE_KEYS = [
  'patient',
  'patient_identifier',
  'abha',
  'mrn',
  'value',
  'quote',
  'text',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'password',
  'token',
  'access_token',
  'secret',
]

const redactPaths = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `req.headers.${key}`])

const allowedLevels = ['debug', 'info', 'warn', 'error'] as const
const configuredLevel = allowedLevels.find((level) => level === process.env.LOG_LEVEL) ?? 'info'

export const logger = pino({
  level: configuredLevel,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'health-ingest' },
  timestamp: pino.stdTimeFunctions.isoTime,
})
