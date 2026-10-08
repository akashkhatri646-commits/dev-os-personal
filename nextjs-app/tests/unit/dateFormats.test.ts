// Every way a clinical document writes a date that the checker must accept. Each row is [text as written, ISO date the model returns].
import { describe, expect, it } from 'vitest'
import { normalizeText } from '@/server/services/extraction/textMatch'
import { checkDate } from '@/server/services/extraction/valueChecks'

const WRITTEN: [string, string][] = [
  ['Date of admission: 01/03/2025', '2025-03-01'],
  ['DOA: 01-03-2025', '2025-03-01'],
  ['Admitted on 01.03.2025', '2025-03-01'],
  ['Admission Date : 1/3/2025', '2025-03-01'],
  ['DOA 01/03/25', '2025-03-01'],
  ['Admission date: 2025-03-01', '2025-03-01'],
  ['Admission date: 2025/03/01', '2025-03-01'],
  ['Admitted: 01 Mar 2025', '2025-03-01'],
  ['Admitted: 1 March 2025', '2025-03-01'],
  ['Admitted: 1st March 2025', '2025-03-01'],
  ['Admitted: 1st March, 2025', '2025-03-01'],
  ['Admitted: 01-Mar-2025', '2025-03-01'],
  ['Admitted: 01-Mar-25', '2025-03-01'],
  ['Admitted: 01/Mar/2025', '2025-03-01'],
  ['Admitted: 01 Mar. 2025', '2025-03-01'],
  ['Admitted: 01Mar2025', '2025-03-01'],
  ['Admitted: 01 MAR 2025', '2025-03-01'],
  ['Admitted: March 1, 2025', '2025-03-01'],
  ['Admitted: March 01 2025', '2025-03-01'],
  ['Admitted: Mar 1st, 2025', '2025-03-01'],
  ['Admitted: Sat, 01 Mar 2025', '2025-03-01'],
  ['Admitted: Saturday 1st March 2025', '2025-03-01'],
  ['Admitted: 01/03/2025 10:30 AM', '2025-03-01'],
  ['Admitted: 01/03/2025, 10:30', '2025-03-01'],
  ['Admitted: 2025-03-01T10:30:00', '2025-03-01'],
  ['Admission date: 01 / 03 / 2025', '2025-03-01'],
  ['Admission date: 01-03-2025.', '2025-03-01'],
  ['(01/03/2025)', '2025-03-01'],
  ['Discharge date: 05/03/2025', '2025-03-05'],
  ['Discharged on the 5th of March 2025', '2025-03-05'],
  ['Discharged 5 th March 2025', '2025-03-05'],
  ['Date of birth: 12-Sep-1980', '1980-09-12'],
  ['Collected 15/10/2024', '2024-10-15'],
  ['Onset: March 2025', '2025-03'],
  ['Onset: 03/2025', '2025-03'],
  ['Since 2019', '2019'],
]

describe('dates as clinical documents write them', () => {
  it.each(WRITTEN)('accepts %s', (text, iso) => {
    const result = checkDate(iso, normalizeText(text))
    expect(result.ok, `"${text}" was not recognised as ${iso}`).toBe(true)
    expect(result.value).toBe(iso)
  })

  it('does not accept a date the text does not contain, or a different day', () => {
    expect(checkDate('2025-03-02', normalizeText('Admitted: 01/03/2025')).ok).toBe(false)
    expect(checkDate('2025-04-01', normalizeText('Admitted: 01/03/2025')).ok).toBe(false)
    expect(checkDate('2024-03-01', normalizeText('Admitted: 01/03/2025')).ok).toBe(false)
    expect(checkDate('2025-03-01', normalizeText('Admission date: not recorded')).ok).toBe(false)
  })

  it('marks an ambiguous day/month order as inferred, and reads day-first', () => {
    const result = checkDate('2025-03-04', normalizeText('Admitted: 04/03/2025'))
    expect(result).toMatchObject({ ok: true, value: '2025-03-04', forceInferred: true })
    // The month-first reading (3 April) is not accepted for a numeric date that is valid day-first.
    expect(checkDate('2025-04-03', normalizeText('Admitted: 04/03/2025')).ok).toBe(false)
    // It is accepted when day-first is impossible.
    expect(checkDate('2025-03-13', normalizeText('Admitted: 03/13/2025')).ok).toBe(true)
  })
})
