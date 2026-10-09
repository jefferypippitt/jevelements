import { connection } from 'next/server'
import { KeyAlert } from '@/components/home/key-alert'
import { RunsTable } from '@/components/home/runs-table'
import { StatusSummary } from '@/components/home/status-summary'
import { readRuns } from '@/lib/runs'

export default async function Home() {
  await connection()
  const runs = await readRuns()
  const typeSafeKey = Boolean(process.env.TYPESAFE_API_KEY?.trim())
  const gatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY?.trim())

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">JevElements Backend</h1>
        <p className="text-sm text-muted-foreground">Key status and recent analyses from the extension.</p>
      </div>
      <KeyAlert typeSafeKey={typeSafeKey} gatewayKey={gatewayKey} />
      <StatusSummary runs={runs} typeSafeKey={typeSafeKey} gatewayKey={gatewayKey} />
      <RunsTable runs={runs} />
    </main>
  )
}
