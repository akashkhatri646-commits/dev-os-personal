'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { SelectField } from '@/components/ui/fields'
import { useToast } from '@/components/ui/Toaster'
import { downloadAuditExport } from '@/lib/api/audit'
import type { AuditFilters } from '@/lib/validation/audit'

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filters: AuditFilters
}

export function ExportDialog({ open, onOpenChange, filters }: ExportDialogProps) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const { toast } = useToast()

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export audit entries?"
      description="Downloads every entry matching the current filters (up to 50,000). The export itself is recorded in the audit log."
      confirmLabel="Export"
      onConfirm={async () => {
        const rows = await downloadAuditExport(filters, format)
        toast({ title: 'Export ready', description: `${rows} entries downloaded`, tone: 'success' })
      }}
      extra={
        <SelectField
          label="Format"
          value={format}
          onChange={(event) => setFormat(event.target.value === 'json' ? 'json' : 'csv')}
          options={[
            { value: 'csv', label: 'CSV (spreadsheet)' },
            { value: 'json', label: 'JSON' },
          ]}
        />
      }
    />
  )
}
