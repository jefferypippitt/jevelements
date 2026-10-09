import { InfoIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export function KeyAlert({ typeSafeKey, gatewayKey }: { typeSafeKey: boolean; gatewayKey: boolean }) {
  const missing = missingKeys(typeSafeKey, gatewayKey)
  if (!missing) return null

  return (
    <Alert variant={missing.severe ? 'destructive' : 'default'}>
      <InfoIcon />
      <AlertTitle>{missing.title}</AlertTitle>
      <AlertDescription>{missing.description}</AlertDescription>
    </Alert>
  )
}

function missingKeys(typeSafeKey: boolean, gatewayKey: boolean) {
  const names = [typeSafeKey ? null : 'TypeSafe', gatewayKey ? null : 'AI Gateway'].filter((name) => name !== null)
  if (names.length === 0) return null
  if (names.length === 1) {
    const name = names[0]
    return {
      severe: false,
      title: `${name} key not set`,
      description: `Add the ${name} key to the environment so that classifier can run.`,
    }
  }
  return {
    severe: true,
    title: 'API keys not set',
    description: 'Add the TypeSafe and AI Gateway keys to the environment so analyses can run.',
  }
}
