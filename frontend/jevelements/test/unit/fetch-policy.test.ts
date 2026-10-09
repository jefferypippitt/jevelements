import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockedMediaUrl, isPrivateHost } from '../../src/shared/fetch-policy'

test('isPrivateHost: loopback, private and link-local hosts', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]']) {
    assert.equal(isPrivateHost(h), true, h)
  }
})

test('isPrivateHost: public hosts', () => {
  for (const h of ['example.com', 'cdn.example.com', '172.15.0.1', '172.32.0.1', '8.8.8.8', '100.128.0.1', '[2606:4700::1]', 'localhost.example.com']) {
    assert.equal(isPrivateHost(h), false, h)
  }
})

test('blockedMediaUrl: public media is allowed', () => {
  assert.equal(blockedMediaUrl('https://cdn.example.com/a.png', 'https://example.com/'), null)
})

test('blockedMediaUrl: private targets are refused from a public page', () => {
  assert.notEqual(blockedMediaUrl('http://127.0.0.1:8080/a.png', 'https://example.com/'), null)
  assert.notEqual(blockedMediaUrl('http://192.168.1.1/x.png', 'https://example.com/'), null)
  assert.notEqual(blockedMediaUrl('http://localhost/a.png', undefined), null)
  assert.notEqual(blockedMediaUrl('http://2130706433/a.png', 'https://example.com/'), null)
})

test('blockedMediaUrl: a private page may load its own private media', () => {
  assert.equal(blockedMediaUrl('http://localhost:3000/a.png', 'http://localhost:3000/'), null)
})

test('blockedMediaUrl: only http(s) and data:', () => {
  assert.notEqual(blockedMediaUrl('file:///etc/hosts', 'https://example.com/'), null)
  assert.notEqual(blockedMediaUrl('ftp://example.com/a.png', 'https://example.com/'), null)
  assert.notEqual(blockedMediaUrl('not a url', 'https://example.com/'), null)
  assert.equal(blockedMediaUrl('data:image/png;base64,AAAA', 'https://example.com/'), null)
})
