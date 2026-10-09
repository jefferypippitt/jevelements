import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RateLimitError } from '@typesafe-ai/sdk'
import { withFallback } from './analyze'

const notAborted = () => false
const fail = (msg: string) => () => Promise.reject(new Error(msg))

test('withFallback uses TypeSafe when it answers', async () => {
  let gatewayCalled = false
  const outcome = await withFallback({
    primary: () => Promise.resolve('typesafe answer'),
    fallback: () => ((gatewayCalled = true), Promise.resolve('gateway answer')),
    aborted: notAborted,
  })
  assert.deepEqual(outcome, { ok: true, aborted: false, provider: 'typesafe', value: 'typesafe answer', fallbackReason: null })
  assert.equal(gatewayCalled, false)
})

test('withFallback hands a failed TypeSafe request (e.g. out of credits) to the gateway', async () => {
  const outcome = await withFallback({
    primary: () => Promise.reject(RateLimitError.fromResponse(429, { error: 'quota exceeded' }, new Headers())),
    fallback: () => Promise.resolve('gateway answer'),
    aborted: notAborted,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.provider, 'gateway')
  assert.match(outcome.fallbackReason ?? '', /quota/)
})

test('withFallback uses the gateway when no TypeSafe key is set', async () => {
  const outcome = await withFallback({ primary: null, fallback: () => Promise.resolve('gateway answer'), aborted: notAborted })
  assert.equal(outcome.provider, 'gateway')
  assert.equal(outcome.fallbackReason, 'TYPESAFE_API_KEY is not set')
})

test('withFallback does not fall back when the caller cancelled', async () => {
  let gatewayCalled = false
  const outcome = await withFallback({
    primary: fail('aborted'),
    fallback: () => ((gatewayCalled = true), Promise.resolve('gateway answer')),
    aborted: () => true,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.aborted, true)
  assert.equal(gatewayCalled, false)
})

test('withFallback reports both errors when TypeSafe and the gateway fail', async () => {
  const outcome = await withFallback({ primary: fail('invalid api key'), fallback: fail('gateway down'), aborted: notAborted })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.provider, 'gateway')
  assert.match(outcome.ok ? '' : String((outcome.error as Error).message), /gateway down.*invalid api key/)
})

test('withFallback without any key asks for TYPESAFE_API_KEY', async () => {
  const outcome = await withFallback({ primary: null, fallback: null, aborted: notAborted })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.provider, 'none')
})
