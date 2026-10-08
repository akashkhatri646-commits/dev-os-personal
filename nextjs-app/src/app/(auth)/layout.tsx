import type { ReactNode } from 'react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-surface px-4 py-12">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}
