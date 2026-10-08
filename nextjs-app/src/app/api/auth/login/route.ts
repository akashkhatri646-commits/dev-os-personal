import { ok, route } from '@/lib/api/route'
import { ROLE_HOME } from '@/lib/auth/roles'
import { loginSchema } from '@/lib/validation/auth'
import { signInWithPassword } from '@/server/services/auth/authService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Password sign-in. Public by necessity; limited to 10 attempts per minute per IP. */
export const POST = route({
  public: true,
  rateLimitPerMinute: 10,
  body: loginSchema,
  handler: async ({ body }) => {
    const { role } = await signInWithPassword(body.email, body.password)
    return ok({ role, redirect_to: ROLE_HOME[role] })
  },
})
