import { accepted, route } from '@/lib/api/route'
import { magicLinkSchema } from '@/lib/validation/auth'
import { sendMagicLink } from '@/server/services/auth/authService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Requests a sign-in email. Always answers 202 so the response never reveals whether the address exists. */
export const POST = route({
  public: true,
  rateLimitPerMinute: 5,
  body: magicLinkSchema,
  handler: async ({ body }) => {
    await sendMagicLink(body.email)
    return accepted({ sent: true })
  },
})
