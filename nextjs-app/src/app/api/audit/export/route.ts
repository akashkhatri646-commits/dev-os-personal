import { AppError } from '@/lib/api/errors'
import { route } from '@/lib/api/route'
import { auditExportSchema, type AuditExportInput } from '@/lib/validation/audit'
import { exportAudit } from '@/server/services/audit/auditQuery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Downloads matching audit entries (max 50,000) as CSV or JSON. The export is itself audited. Admin only. */
export const POST = route<never, AuditExportInput>({
  roles: ['admin'],
  body: auditExportSchema,
  rateLimitPerMinute: 6,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const file = await exportAudit(user, body)
    return new Response(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'x-row-count': String(file.rowCount),
        'x-content-type-options': 'nosniff',
      },
    })
  },
})
