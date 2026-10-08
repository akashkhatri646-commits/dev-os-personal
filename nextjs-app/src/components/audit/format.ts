const utcFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
})

/** Audit timestamps are always shown in UTC and labelled as such. */
export function formatAuditTime(iso: string): string {
  return `${utcFormatter.format(new Date(iso))} UTC`
}
