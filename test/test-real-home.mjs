/**
 * Exercise the installed Host half against the real Harness home: trash one
 * disposable Session, list the trash, then restore it.
 */
import { pathToFileURL } from 'node:url'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const home = process.env.USERPROFILE + '\\.dsh'
process.env.DSH_HOME = home

const sessionId = process.argv[2]
let route
const plugin = await import(pathToFileURL(process.argv[3]).href)
plugin.apply({
  logger: { warn: (message) => console.log('warn:', message) },
  get: () => undefined,
  connection: { fetch: { register: (registration) => { route = registration } } },
})

function assert(condition, label) {
  if (!condition) throw new Error(`FAILED: ${label}`)
  console.log(`  ok  ${label}`)
}

const call = (init) => route.fetch(new Request('http://local/api/session-trash', init))

let response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId }) })
let body = await response.json()
console.log('trash ->', response.status, JSON.stringify(body).slice(0, 220))
assert(response.ok && body.ok === true, 'real session trashed')
const entry = body.entry

response = await call()
body = await response.json()
assert(body.ok === true && body.items.some((item) => item.id === sessionId), 'listed in the trash')
const item = body.items.find((entryItem) => entryItem.id === sessionId)
console.log('listed:', item.title, '|', item.cwd, '|', item.bytes, 'bytes')

response = await call({ method: 'POST', body: JSON.stringify({ action: 'restore', entry }) })
body = await response.json()
assert(response.ok && body.ok === true, 'restored')
const back = await stat(join(home, 'sessions', item.project, sessionId, 'session.v4.jsonl.zstd'))
assert(back.size > 0, 'log file back in place')

response = await call()
body = await response.json()
assert(!body.items.some((entryItem) => entryItem.id === sessionId), 'trash entry cleared')

console.log('REAL-DATA ROUND TRIP: passed')
