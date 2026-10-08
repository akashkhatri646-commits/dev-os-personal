import 'server-only'
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { AppError } from '@/lib/api/errors'
import { normalizePatientIdentifier, type PatientIdentifier } from '@/lib/validation/patientIdentifier'
import { requireEnvValue } from '@/server/config/env'

/**
 * Deterministic lookup hash for a patient identifier: HMAC-SHA256 over `<type>:<normalised value>`
 * keyed with PATIENT_ID_HMAC_KEY. Identifiers are only ever searched by this hash, never stored or
 * logged in plaintext (spec 03 §2).
 */
export function hashPatientIdentifier(
  identifier: PatientIdentifier,
  key: string = requireEnvValue('PATIENT_ID_HMAC_KEY'),
): string {
  const normalised = normalizePatientIdentifier(identifier)
  return createHmac('sha256', key).update(`${identifier.type}:${normalised}`).digest('hex')
}

const IV_LENGTH = 12
const TAG_LENGTH = 16

function encryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== 32) {
    throw new AppError('INTERNAL', 'PATIENT_ID_ENC_KEY must be a base64-encoded 32-byte key.', { retryable: false })
  }
  return key
}

/** AES-256-GCM. Output layout: iv (12) | auth tag (16) | ciphertext. */
export function encryptIdentifier(
  plaintext: string,
  base64Key: string = requireEnvValue('PATIENT_ID_ENC_KEY'),
): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(base64Key), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decryptIdentifier(
  payload: Buffer,
  base64Key: string = requireEnvValue('PATIENT_ID_ENC_KEY'),
): string {
  const iv = payload.subarray(0, IV_LENGTH)
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(base64Key), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** PostgREST representation of a `bytea` value. */
export function toBytea(buffer: Buffer): string {
  return `\\x${buffer.toString('hex')}`
}

export function fromBytea(value: string): Buffer {
  return Buffer.from(value.startsWith('\\x') ? value.slice(2) : value, 'hex')
}
