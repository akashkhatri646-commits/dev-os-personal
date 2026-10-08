import { z } from 'zod'

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
// Standalone digit runs only: a UUID's all-digit group is preceded by "-" or hex characters and is ignored.
const LONG_DIGITS_PATTERN = /(?<![0-9A-Fa-f-])\d{10,}(?![0-9A-Fa-f-])/

/** True when text looks like it contains an email address or a 10+ digit identifier (ABHA, phone). */
export function containsPersonalData(text: string): boolean {
  return EMAIL_PATTERN.test(text) || LONG_DIGITS_PATTERN.test(text)
}

/**
 * Free-text note/reason that ends up in audit trails or settings: length-bounded and free of
 * obvious personal identifiers (spec 00 §7, no PHI in audit data).
 */
export function safeNote(min: number, max = 300) {
  return z
    .string()
    .trim()
    .min(min, `Enter at least ${min} characters`)
    .max(max, `Keep it under ${max} characters`)
    .refine((value) => !containsPersonalData(value), {
      message: 'Do not include personal data (emails, phone or ID numbers) here',
    })
}
