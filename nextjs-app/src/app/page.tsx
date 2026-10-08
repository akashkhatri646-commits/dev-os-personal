// Server Component: no event handlers here. Hover/focus styles live in globals.css classes.

const PIPELINE_STAGES = [
  { name: 'Ingest & normalize', detail: 'Scans, faxes, HL7v2 and notes to text' },
  { name: 'Consent gate', detail: 'Hard block before any processing' },
  { name: 'Grounded extraction', detail: 'Every field cites its source span' },
  { name: 'Mapping & validation', detail: 'SNOMED CT / LOINC and FHIR R4 profiles' },
  { name: 'Confidence scoring', detail: 'Per-field and aggregate certainty' },
  { name: 'Routing gate', detail: 'Auto-commit or escalate by threshold' },
  { name: 'Review queue', detail: 'Accept, correct or reject per field' },
  { name: 'Commit & audit', detail: 'Provenance and immutable decision trail' },
] as const

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col gap-10 bg-bg-primary px-6 py-12 md:px-28 md:py-24">
      <header className="flex flex-col gap-4">
        <span className="badge-info w-fit">Foundation ready</span>
        <h1 className="text-h2 text-text-primary md:text-h1">
          Trust at the Edge
        </h1>
        <p className="max-w-2xl text-body-lg text-text-secondary">
          Agentic ingestion for unstructured health records. Convert scans,
          faxes and non-standard feeds into consented, coded, validated FHIR
          data, committed automatically only when the system can show why it
          is confident.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href="/login" className="btn-primary">
            Sign in
          </a>
          <a
            href="https://nextjs.org/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            Next.js docs
          </a>
        </div>
      </header>

      <section className="flex w-full flex-col gap-6" aria-labelledby="pipeline">
        <h2 id="pipeline" className="text-h5 text-text-primary">
          Pipeline
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PIPELINE_STAGES.map((stage, index) => (
            <li
              key={stage.name}
              className="flex flex-col gap-0.5 rounded-lg border border-border bg-bg-primary p-4"
            >
              <span className="text-body-sm text-text-secondary">
                Stage {index + 1}
              </span>
              <span className="text-body-lg text-text-primary">
                {stage.name}
              </span>
              <span className="text-body-sm text-text-secondary">
                {stage.detail}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}
