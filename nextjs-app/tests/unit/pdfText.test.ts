import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { AppError } from '@/lib/api/errors'
import { MIN_CHARS_PER_PAGE, extractPdfText } from '@/server/services/normalization/pdfText'

const LINES = [
  'DISCHARGE SUMMARY',
  'Patient was admitted on 12/09/2026 with fever and productive cough for three days.',
  'Diagnosis: Community acquired pneumonia. Comorbidity: Type 2 diabetes mellitus.',
  'Treatment: Tab Amoxicillin 500 mg thrice daily for 7 days. Tab Metformin 500 mg BD.',
  'Discharged on 16/09/2026 in stable condition. Review in outpatient clinic after one week.',
]

async function makePdf(pages: string[][]): Promise<Buffer> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const page = document.addPage([595, 842])
    lines.forEach((line, index) => page.drawText(line, { x: 50, y: 780 - index * 24, size: 10, font }))
  }
  return Buffer.from(await document.save())
}

describe('extractPdfText: digital PDFs', () => {
  it('reads the text layer into pages of citeable blocks, one per line, in reading order', async () => {
    const result = await extractPdfText(await makePdf([LINES, LINES]))
    expect(result.pageCount).toBe(2)
    expect(result.pages).not.toBeNull()
    const first = result.pages?.[0]
    expect(first?.blocks.map((block) => block.text)).toEqual(LINES)
    expect(first?.blocks.map((block) => block.id)).toEqual(['p1b1', 'p1b2', 'p1b3', 'p1b4', 'p1b5'])
    expect(result.pages?.[1]?.blocks[0]?.id).toBe('p2b1')
    expect(first?.text).toContain('Tab Metformin 500 mg BD')
  })

  it('gives each block a normalised, top-left based bounding box', async () => {
    const result = await extractPdfText(await makePdf([LINES]))
    const boxes = result.pages?.[0]?.blocks.map((block) => block.bbox) ?? []
    expect(boxes).toHaveLength(LINES.length)
    for (const box of boxes) {
      expect(box).toBeDefined()
      const [x0, y0, x1, y1] = box ?? [0, 0, 0, 0]
      expect(x0).toBeGreaterThanOrEqual(0)
      expect(x1).toBeLessThanOrEqual(1)
      expect(y0).toBeLessThan(y1)
      expect(x0).toBeLessThan(x1)
    }
    // Later lines sit lower on the page, i.e. have a larger top coordinate.
    const tops = boxes.map((box) => box?.[1] ?? 0)
    expect([...tops].sort((a, b) => a - b)).toEqual(tops)
  })

  it('marks digital text as highly confident but below a perfect score', async () => {
    const result = await extractPdfText(await makePdf([LINES]))
    expect(result.pages?.[0]?.confidence).toBe(0.99)
    expect(result.pages?.[0]?.blocks.every((block) => block.confidence === 0.99)).toBe(true)
  })
})

describe('extractPdfText: scans and bad files', () => {
  it('reports no usable text layer for a blank (scanned-looking) PDF so it can go to OCR', async () => {
    const result = await extractPdfText(await makePdf([[], []]))
    expect(result.pageCount).toBe(2)
    expect(result.pages).toBeNull()
    expect(result.charsPerPage).toBe(0)
  })

  it('treats a PDF with only a stray caption as a scan (below the per-page character minimum)', async () => {
    const result = await extractPdfText(await makePdf([['Scanned by City Hospital']]))
    expect(result.charsPerPage).toBeLessThan(MIN_CHARS_PER_PAGE)
    expect(result.pages).toBeNull()
  })

  it('averages characters across pages: one text-heavy page among blank ones is still a scan', async () => {
    const result = await extractPdfText(await makePdf([LINES, [], [], [], []]))
    expect(result.pages).toBeNull()
  })

  it('raises unreadable_document for a corrupt file', async () => {
    let thrown: unknown
    try {
      await extractPdfText(Buffer.from('%PDF-1.7 this is not really a pdf'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).reason).toBe('unreadable_document')
  })

  it('raises unreadable_document for arbitrary bytes', async () => {
    await expect(extractPdfText(Buffer.from([1, 2, 3, 4, 5]))).rejects.toMatchObject({ reason: 'unreadable_document' })
  })
})
