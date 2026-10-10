// Turns the synthetic demo summaries (docs/demo-data/*.txt) into typed PDFs with a real text layer, the kind the app
// reads without OCR.   node scripts/make-demo-pdfs.mjs
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const root = path.resolve(import.meta.dirname, '..', '..', 'docs', 'demo-data')
const out = path.join(root, 'pdf')
mkdirSync(out, { recursive: true })

const PAGE = { width: 595, height: 842 }
const MARGIN = 56
const SIZE = 12
const LEAD = 20

function wrap(text, font, maxWidth) {
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, SIZE) > maxWidth && line) {
        lines.push(line)
        line = word
      } else line = candidate
    }
    lines.push(line)
  }
  return lines
}

for (const file of readdirSync(root).filter((name) => name.endsWith('.txt'))) {
  const text = readFileSync(path.join(root, file), 'utf8').trim()
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - MARGIN
  for (const [index, line] of wrap(text, regular, PAGE.width - MARGIN * 2).entries()) {
    const isTitle = index === 0
    page.drawText(line, { x: MARGIN, y, size: isTitle ? 15 : SIZE, font: isTitle ? bold : regular, color: rgb(0, 0, 0) })
    y -= isTitle ? LEAD + 6 : LEAD
  }
  writeFileSync(path.join(out, file.replace(/\.txt$/, '.pdf')), await pdf.save())
  console.log('wrote', file.replace(/\.txt$/, '.pdf'))
}
