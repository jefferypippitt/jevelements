import { InboxIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Run } from '@/lib/runs'
import { cn } from '@/lib/utils'
import { ClearRunsButton } from './clear-runs-button'

const PROVIDER: Record<Run['provider'], string> = {
  typesafe: 'TypeSafe',
  gateway: 'AI Gateway',
  none: 'None',
}

export function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>No analyses yet</EmptyTitle>
          <EmptyDescription>Capture a section with the extension to see it here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium tracking-tight">Recent Analyses</h2>
          <p className="text-sm text-muted-foreground">Reload the page to see new analyses.</p>
        </div>
        <ClearRunsButton count={runs.length} />
      </div>
      <div className="rounded-none border">
        <Table className="table-fixed min-w-4xl border-collapse [&_td:not(:last-child)]:border-r [&_th:not(:last-child)]:border-r">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[18%]">Time</TableHead>
              <TableHead className="w-[18%]">Website</TableHead>
              <TableHead className="w-[13%]">Provider</TableHead>
              <TableHead className="w-[11%]">Status</TableHead>
              <TableHead className="w-[13%]">Section</TableHead>
              <TableHead className="w-[16%]">Model</TableHead>
              <TableHead className="w-[11%] text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run, i) => (
              <RunRow key={`${run.at}-${i}`} run={run} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function RunRow({ run }: { run: Run }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground">{formatTime(run.at)}</TableCell>
      <TableCell className="max-w-0">
        {run.url ? (
          <a href={run.url} target="_blank" rel="noreferrer" title={run.url} className="block truncate underline-offset-4 hover:underline">
            {formatSite(run.url)}
          </a>
        ) : (
          <Dash />
        )}
      </TableCell>
      <TableCell>{PROVIDER[run.provider]}</TableCell>
      <TableCell className={cn(run.ok ? 'text-success' : 'text-destructive')}>{run.ok ? 'OK' : 'Failed'}</TableCell>
      <TableCell className="truncate">{run.sectionType ?? <Dash />}</TableCell>
      <TableCell className="max-w-0 truncate">{run.model ?? 'None'}</TableCell>
      <TableCell className="text-right tabular-nums">{(run.durationMs / 1000).toFixed(1)}s</TableCell>
    </TableRow>
  )
}

function Dash() {
  return <span className="text-muted-foreground">—</span>
}

// vercel.com/home: the host without www, and the path when there is one.
function formatSite(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const host = hostname.replace(/^www\./, '')
    return pathname === '/' ? host : `${host}${pathname.replace(/\/$/, '')}`
  } catch {
    return url
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })
}
