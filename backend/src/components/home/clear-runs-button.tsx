'use client'

import { Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState, useTransition } from 'react'
import { clearRunsAction } from '@/app/actions'
import { cn } from '@/lib/utils'

const BASE =
  'inline-flex h-8 items-center gap-1.5 rounded-none border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const OUTLINE = cn(BASE, 'bg-background hover:bg-muted')
const DESTRUCTIVE = cn(BASE, 'border-destructive bg-destructive text-white hover:bg-destructive/90')

// Delete all with an inline confirm: clearing the log can't be undone, but a modal is overkill here.
// Focus lands on Cancel so a stray Enter doesn't delete.
export function ClearRunsButton({ count }: { count: number }) {
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirming) cancelRef.current?.focus()
  }, [confirming])

  if (!confirming) {
    return (
      <button type="button" className={OUTLINE} onClick={() => setConfirming(true)}>
        <Trash2Icon className="size-4" />
        Delete all
      </button>
    )
  }

  return (
    <div
      className="flex items-center gap-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) setConfirming(false)
      }}
    >
      <span className="text-sm text-muted-foreground">
        Delete {count} {count === 1 ? 'analysis' : 'analyses'}?
      </span>
      <button
        type="button"
        className={DESTRUCTIVE}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await clearRunsAction()
          })
        }
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      <button ref={cancelRef} type="button" className={OUTLINE} disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  )
}
