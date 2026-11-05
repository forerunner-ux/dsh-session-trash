/**
 * Offline harness for the session-trash plugin: exercises the Host half against
 * a throwaway DSH_HOME, both with and without the live Workspace storage domain.
 */
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'dsh-trash-test-'))
process.env.DSH_HOME = home

const sessionsRoot = join(home, 'sessions')
const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
const workspaceFile = join(home, 'storages', 'workspace.json')
const project = '--E-DS--'
const logDir = join(sessionsRoot, project, 'session-aaaa')
await mkdir(logDir, { recursive: true })
await writeFile(join(logDir, 'session.v4.jsonl.zstd'), 'not-really-zstd')
await mkdir(cacheRoot, { recursive: true })
await writeFile(join(cacheRoot, 'session-aaaa.json'), JSON.stringify({
  record: { identity: { cwd: 'E:\\DS' }, rows: { title: { val: '测试会话标题' } } },
}))

/**
 * Write a Workspace catalog document in the shape the sidebar persists.
 * @param sessionIds - ids listed by the single `ws-a` workspace.
 */
async function writeCatalog(sessionIds) {
	await mkdir(join(home, 'storages'), { recursive: true })
	await writeFile(workspaceFile, JSON.stringify({
		unit: { name: 'workspace', version: 2 },
		global: {
			initialized: true,
			defaultWorkspaceId: 'ws-a',
			workspaceIds: ['ws-a'],
			archivedSessionIds: [],
			pinnedSessionIds: [],
		},
		tables: {
			workspaces: {
				'ws-a': {
					path: 'E:\\DS',
					title: 'DS',
					sessionIds,
					createdAt: '2026-08-15T06:12:24.086Z',
					updatedAt: '2026-11-05T10:03:33.066Z',
				},
			},
		},
	}, undefined, 2), 'utf8')
}

async function readCatalog() {
	return JSON.parse(await readFile(workspaceFile, 'utf8'))
}

await writeCatalog(['session-aaaa', 'session-ghost'])

/** Mutable Host surface: the domain arrives in the second scenario. */
const surface = { storageDomain: undefined }
let route
const running = new Set()
const plugin = await import(pathToFileURL(process.argv[2]).href)
const agents = { get: (id) => (running.has(id) ? { status: 'running' } : undefined) }
plugin.apply({
	logger: { warn: (message) => console.log('  [host warn]', message) },
	agents,
	get: (name) => {
		if (name === 'agents') return agents
		if (name === 'storageDomain') return surface.storageDomain
		return undefined
	},
	connection: { fetch: { register: (registration) => { route = registration } } },
})

function assert(condition, label) {
	if (!condition) throw new Error(`FAILED: ${label}`)
	console.log(`  ok  ${label}`)
}

function call(init) {
	return route.fetch(new Request('http://local/api/session-trash', init))
}

console.log('route registered:', route.path, route.methods.join(','))
assert(route.path === '/api/session-trash', 'route path')

let response = await call()
let body = await response.json()
assert(response.status === 200 && body.ok === true, 'list ok')
assert(body.items.length === 0, 'list starts empty')

// Refuse a running Session.
running.add('session-aaaa')
response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-aaaa' }) })
body = await response.json()
assert(response.status === 409 && body.error.code === 'SESSION_RUNNING', 'refuses a running session')
running.delete('session-aaaa')

// Trash it: the directory moves and the workspace catalog drops the row.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-aaaa' }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'trash ok')
assert(body.kind === 'session', 'trash reports a session entry')
assert((await stat(join(sessionsRoot, project, 'session-aaaa')).catch(() => undefined)) === undefined, 'session dir moved away')
assert((await stat(join(cacheRoot, 'session-aaaa.json')).catch(() => undefined)) === undefined, 'projection cache removed')
assert((await readCatalog()).tables.workspaces['ws-a'].sessionIds.join(',') === 'session-ghost', 'catalog detached the session')

// Listing carries title/cwd/size.
response = await call()
body = await response.json()
assert(body.items.length === 1, 'one trashed item')
const item = body.items[0]
assert(item.title === '测试会话标题', 'title preserved')
assert(item.cwd === 'E:\\DS', 'cwd preserved')
assert(item.project === project, 'project preserved')
assert(item.kind === 'session', 'listed entry kind')
assert(item.bytes > 0 && Array.isArray(item.entry) === false, 'size measured')
console.log('  entry:', item.entry, item.bytes, 'bytes')

// Restore puts both the log and the catalog row back.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'restore', entry: item.entry }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'restore ok')
assert((await stat(join(sessionsRoot, project, 'session-aaaa', 'session.v4.jsonl.zstd'))).size > 0, 'log back in place')
assert((await readCatalog()).tables.workspaces['ws-a'].sessionIds.join(',') === 'session-aaaa,session-ghost', 'catalog re-attached at the old index')
response = await call()
body = await response.json()
assert(body.items.length === 0, 'trash empty after restore')

// A Session that never wrote a log: it only owns a catalog row.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-ghost' }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'empty session trash ok')
assert(body.kind === 'catalog', 'empty session trashed as catalog entry')
assert((await readCatalog()).tables.workspaces['ws-a'].sessionIds.join(',') === 'session-aaaa', 'empty session dropped from the catalog')
response = await call()
body = await response.json()
const ghost = body.items.find((entry) => entry.id === 'session-ghost')
assert(ghost !== undefined && ghost.kind === 'catalog', 'empty session listed as catalog entry')
assert(ghost.bytes === 0 && ghost.cwd === 'E:\\DS', 'catalog entry carries the workspace path')

// Restore the empty session.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'restore', entry: ghost.entry }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'empty session restore ok')
assert((await readCatalog()).tables.workspaces['ws-a'].sessionIds.join(',') === 'session-aaaa,session-ghost', 'empty session re-attached')

// Restore refuses when the workspace itself is gone.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-ghost' }) })
body = await response.json()
const ghostEntry = body.entry
const saved = await readCatalog()
const orphan = { ...saved, tables: { workspaces: {} } }
await writeFile(workspaceFile, JSON.stringify(orphan, undefined, 2), 'utf8')
response = await call({ method: 'POST', body: JSON.stringify({ action: 'restore', entry: ghostEntry }) })
body = await response.json()
assert(response.status === 409 && body.error.code === 'ENTRY_NOT_RESTORABLE', 'restore refuses a vanished workspace')
await writeFile(workspaceFile, JSON.stringify(saved, undefined, 2), 'utf8')

// Purge the catalog entry: nothing comes back.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'purge', entry: ghostEntry }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'catalog purge ok')
assert((await readCatalog()).tables.workspaces['ws-a'].sessionIds.join(',') === 'session-aaaa', 'purged catalog entry stays gone')

// Trash + purge a real Session.
await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-aaaa' }) })
response = await call()
body = await response.json()
const second = body.items[0]
response = await call({ method: 'POST', body: JSON.stringify({ action: 'purge', entry: second.entry }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'purge ok')
response = await call()
body = await response.json()
assert(body.items.length === 0, 'trash empty after purge')
assert((await stat(join(sessionsRoot, project, 'session-aaaa')).catch(() => undefined)) === undefined, 'purged session stays gone')

// Unknown Session and bad action.
response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-nope' }) })
body = await response.json()
assert(response.status === 404 && body.error.code === 'SESSION_NOT_FOUND', 'unknown session 404')
response = await call({ method: 'POST', body: JSON.stringify({ action: 'nonsense' }) })
assert(response.status === 400, 'bad action 400')

// ------------------------------------------------- live Workspace storage domain
await writeCatalog(['session-ghost'])

/**
 * Minimal stand-in for the open `workspace` domain the Host exposes.
 * @param doc - the catalog document to serve.
 */
function makeDomain(doc) {
	const records = new Map(Object.entries(doc.tables.workspaces))
	let global = structuredClone(doc.global)
	const calls = []
	const table = {
		entries: () => records.entries(),
		keys: () => records.keys(),
		get: (key) => records.get(key),
		put: async (key, value) => {
			calls.push(`put:${key}`)
			records.set(key, value)
		},
		update: async (key, fn) => {
			calls.push(`update:${key}`)
			const next = fn(records.get(key))
			records.set(key, next)
			return next
		},
		delete: async (key) => records.delete(key),
		deleteMany: async (keys) => keys.filter((key) => records.delete(key)).length,
		size: records.size,
	}
	return {
		name: 'workspace',
		table: (name) => {
			if (name !== 'workspaces') throw new Error(`unexpected table ${name}`)
			return table
		},
		global: {
			get: () => global,
			set: async (value) => {
				calls.push('global:set')
				global = value
			},
		},
		calls,
		records,
	}
}

const domain = makeDomain(await readCatalog())
surface.storageDomain = { get: (name) => (name === 'workspace' ? domain : undefined) }
response = await call({ method: 'POST', body: JSON.stringify({ action: 'trash', sessionId: 'session-ghost' }) })
body = await response.json()
assert(response.status === 200 && body.ok === true, 'domain-backed trash ok')
assert(domain.records.get('ws-a').sessionIds.length === 0, 'domain record detached in place')
assert(domain.calls.some((entry) => entry.startsWith('update:ws-a')), 'domain update used instead of the file')
assert((await readCatalog()).tables.workspaces['ws-a'].sessionIds.join(',') === 'session-ghost', 'file untouched while the domain is live')
response = await call({ method: 'POST', body: JSON.stringify({ action: 'restore', entry: body.entry }) })
assert(response.status === 200, 'domain-backed restore ok')
assert(domain.records.get('ws-a').sessionIds.join(',') === 'session-ghost', 'domain record re-attached in place')

await rm(home, { recursive: true, force: true })
console.log('HOST HALF: all checks passed')
