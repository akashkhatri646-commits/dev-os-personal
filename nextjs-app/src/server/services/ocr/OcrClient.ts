import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/server/config/env'
import type { OcrClient } from '@/types/ocr'

export type { OcrClient, OcrInput, OcrPage, OcrResult } from '@/types/ocr'

/**
 * The recognition engine selected by OCR_PROVIDER, or `null` when none is configured (the
 * normalisation stage then holds scans for review instead of guessing).
 *
 * The Textract and Document AI adapters are added once a provider and region are chosen. Selecting
 * one before then throws a non-retryable error, so the record is escalated with a clear reason
 * rather than being treated as recognised.
 */
export function getOcrClient(provider: 'textract' | 'documentai' | undefined = getEnv().OCR_PROVIDER): OcrClient | null {
  if (!provider) return null
  throw new AppError('INTERNAL', `The ${provider} OCR adapter is not available in this release.`, {
    retryable: false,
  })
}
