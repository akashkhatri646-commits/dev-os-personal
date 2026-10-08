import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

// Design system font is "Inter Display", which is not on Google Fonts at Next 14.2.5;
// Inter (same family) is used until the Inter Display files are self-hosted.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Trust at the Edge — Agentic Health Record Ingestion',
  description:
    'Consent-gated, grounded, confidence-scored ingestion of unstructured health records into FHIR.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  )
}
