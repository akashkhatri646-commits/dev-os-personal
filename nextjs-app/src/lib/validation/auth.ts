import { z } from 'zod'
import { ROLES } from '@/types/domain'

/** Lower-cased, trimmed, syntactically valid email (profiles.email is stored lower-case). */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254))

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(256),
})
export type LoginInput = z.infer<typeof loginSchema>

export const magicLinkSchema = z.object({ email: emailSchema })
export type MagicLinkInput = z.infer<typeof magicLinkSchema>

export const roleSchema = z.enum(ROLES)

export const inviteUserSchema = z.object({
  email: emailSchema,
  full_name: z.string().trim().min(1, 'Enter a name').max(120),
  role: roleSchema,
})
export type InviteUserInput = z.infer<typeof inviteUserSchema>

export const updateUserSchema = z
  .object({
    role: roleSchema.optional(),
    active: z.boolean().optional(),
    full_name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Provide at least one field to update',
  })
export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const userIdParamsSchema = z.object({ id: z.uuid() })
