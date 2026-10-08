/** Text normalisation and approximate matching used to verify quotes against the document. */

const ZERO_WIDTH = /[​-‍⁠﻿]/
const WHITESPACE = /\s/

export interface NormalizedText {
  /** Lower-cased, NFKC-normalised text with whitespace collapsed and zero-width characters removed. */
  norm: string
  /** For every character of `norm`, its index in the original string. */
  map: number[]
}

/**
 * Normalises text for comparison while remembering where every kept character came from, so a match
 * found in the normalised text can be reported at its true position in the original page.
 */
export function normalizeWithMap(text: string): NormalizedText {
  let norm = ''
  const map: number[] = []
  let index = 0
  for (const char of text) {
    const originalIndex = index
    index += char.length
    if (ZERO_WIDTH.test(char)) continue
    if (WHITESPACE.test(char)) {
      if (norm.length > 0 && !norm.endsWith(' ')) {
        norm += ' '
        map.push(originalIndex)
      }
      continue
    }
    for (const piece of char.normalize('NFKC').toLowerCase()) {
      norm += piece
      map.push(originalIndex)
    }
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1)
    map.pop()
  }
  return { norm, map }
}

export function normalizeText(text: string): string {
  return normalizeWithMap(text).norm
}

export interface ApproxMatch {
  /** Edit distance between the pattern and the best-matching substring of the text. */
  distance: number
  /** Start (inclusive) and end (exclusive) of that substring in the text. */
  start: number
  end: number
}

/**
 * Finds the substring of `text` closest to `pattern` (Sellers' approximate substring matching, with
 * edit distance). Used to accept a quote that differs from the document only by OCR noise.
 */
export function approximateFind(text: string, pattern: string): ApproxMatch {
  const m = pattern.length
  const n = text.length
  let previousCost = Array.from({ length: m + 1 }, (_, j) => j)
  let previousStart = new Array<number>(m + 1).fill(0)
  let best: ApproxMatch = { distance: m, start: 0, end: 0 }

  for (let i = 1; i <= n; i += 1) {
    const cost = new Array<number>(m + 1).fill(0)
    const start = new Array<number>(m + 1).fill(i)
    for (let j = 1; j <= m; j += 1) {
      const substitution = (previousCost[j - 1] ?? 0) + (text[i - 1] === pattern[j - 1] ? 0 : 1)
      const skippedTextChar = (previousCost[j] ?? 0) + 1
      const missingTextChar = (cost[j - 1] ?? 0) + 1
      let value = substitution
      let origin = previousStart[j - 1] ?? 0
      if (skippedTextChar < value) {
        value = skippedTextChar
        origin = previousStart[j] ?? 0
      }
      if (missingTextChar < value) {
        value = missingTextChar
        origin = start[j - 1] ?? i
      }
      cost[j] = value
      start[j] = origin
    }
    const finalCost = cost[m] ?? m
    if (finalCost < best.distance) best = { distance: finalCost, start: start[m] ?? 0, end: i }
    previousCost = cost
    previousStart = start
  }
  return best
}

/** Letters and digits only, split into words. */
export function wordsOf(normalised: string): string[] {
  return normalised.match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Share of `value` words that appear in `quote` (0..1). */
export function wordOverlap(valueNorm: string, quoteNorm: string): number {
  const valueWords = wordsOf(valueNorm)
  if (valueWords.length === 0) return 0
  const quoteWords = new Set(wordsOf(quoteNorm))
  return valueWords.filter((word) => quoteWords.has(word)).length / valueWords.length
}
