import type { ReactNode } from 'react'
import type { Run } from '@/lib/runs'
import { cn } from '@/lib/utils'

export function StatusSummary({
  runs,
  typeSafeKey,
  gatewayKey,
}: {
  runs: Run[]
  typeSafeKey: boolean
  gatewayKey: boolean
}) {
  const fallbacks = runs.filter((run) => run.provider === 'gateway' && run.ok).length
  const failed = runs.filter((run) => !run.ok).length

  return (
    <dl className="grid grid-cols-2 gap-px rounded-none border bg-border lg:grid-cols-4">
      <Stat label="TypeSafe key">
        <KeyDot set={typeSafeKey} />
      </Stat>
      <Stat label="AI Gateway key">
        <KeyDot set={gatewayKey} />
      </Stat>
      <Stat label="Runs">{runs.length}</Stat>
      <Stat label="Fallbacks / Failed">
        {fallbacks} / {failed}
      </Stat>
    </dl>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-background px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex h-6 items-center text-base font-medium">{children}</dd>
    </div>
  )
}

function KeyDot({ set }: { set: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className={cn('size-2 rounded-full', set ? 'bg-success' : 'bg-destructive')} />
      {set ? 'On' : 'Off'}
    </span>
  )
}
