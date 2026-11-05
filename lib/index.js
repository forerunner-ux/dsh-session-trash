/**
 * Session trash Host half.
 *
 * Moves one Session log directory from `<DSH_HOME>/sessions/<project>/<id>` into
 * `<DSH_HOME>/trash/sessions/<stamp>-<id>/` and back, and serves both operations
 * plus listing and permanent removal over one authenticated route.
 *
 * The route lives at the absolute pathname `/api/session-trash`; the browser
 * addresses it document-relatively as `api/session-trash`.
 *
 * @module dsh-session-trash
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Cordis plugin name. */
const name = 'session-trash'

/** Only the authenticated fetch route registry is required. */
const inject = ['connection']

/** Absolute registration path. */
const ROUTE_PATH = '/api/session-trash'

/** One safe path segment: Session ids never carry separators or traversal. */
const SAFE_SEGMENT = /^[A-Za-z0-9._~@-]+$/u

/**
 * Resolve the Harness home the same way the rest of the product does: an
 * explicit `DSH_HOME`, then `~/.dsh`.
 * @returns the absolute Harness home.
 */
function dshHome() {
	const fromEnv = process.env.DSH_HOME
	return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), '.dsh')
}

const sessionsRoot = () => join(dshHome(), 'sessions')
const cacheRoot = () => join(dshHome(), 'storages', 'session_projcache', 'sessions')
const trashRoot = () => join(dshHome(), 'trash', 'sessions')

/** Storage-domain name/table that own the sidebar's Workspace catalog. */
const WORKSPACE_DOMAIN = 'workspace'
const WORKSPACE_TABLE = 'workspaces'

/** Persisted fallback for the same catalog when the live domain is unavailable. */
const workspaceFile = () => join(dshHome(), 'storages', 'workspace.json')

/**
 * Reply with one JSON body.
 * @param body - JSON-serialisable payload.
 * @param status - HTTP status.
 * @returns the response.
 */
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	})
}

/**
 * Reply with one typed failure.
 * @param status - HTTP status.
 * @param code - stable machine-readable code.
 * @param message - human-readable explanation.
 * @returns the response.
 */
function fail(status, code, message) {
	return json({ ok: false, error: { code, message } }, status)
}

/**
 * Read the projection-cache record of one Session, which carries the folded
 * title and the recorded cwd without opening the compressed log.
 * @param id - Session id.
 * @returns the record's `rows.title.val` and `identity.cwd` when present.
 */
async function readCachedMeta(id) {
	try {
		const text = await readFile(join(cacheRoot(), `${id}.json`), 'utf8')
		const parsed = JSON.parse(text)
		const record = parsed?.record ?? parsed
		return {
			title: typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : '',
			cwd: typeof record?.identity?.cwd === 'string' ? record.identity.cwd : '',
		}
	} catch {
		return { title: '', cwd: '' }
	}
}

/**
 * Find the Session-owned directory across every project directory.
 * @param id - Session id, used verbatim as the directory name.
 * @returns the absolute Session directory, or `undefined` when absent.
 */
async function findSessionDir(id) {
	if (!SAFE_SEGMENT.test(id)) return undefined
	let projects
	try {
		projects = await readdir(sessionsRoot(), { withFileTypes: true })
	} catch {
		return undefined
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue
		const candidate = join(sessionsRoot(), project.name, id)
		try {
			if ((await stat(candidate)).isDirectory()) return { dir: candidate, project: project.name }
		} catch {
			// Not in this project directory.
		}
	}
	return undefined
}

/**
 * Borrow the live Workspace storage domain, when the Host exposes it. The
 * domain is already open (storage facilities are single-open), so this only
 * looks it up; it never opens or closes one.
 * @param ctx - Host context.
 * @returns the open domain, or `undefined` when unavailable.
 */
function workspaceDomain(ctx) {
	try {
		const hub = ctx.get?.('storageDomain') ?? Reflect.get(ctx, 'storageDomain')
		const domain = hub?.get?.(WORKSPACE_DOMAIN)
		return domain !== undefined && typeof domain?.table === 'function' ? domain : undefined
	} catch {
		return undefined
	}
}

/**
 * Read the persisted Workspace document.
 * @returns the parsed document.
 */
async function readWorkspaceFile() {
	return JSON.parse(await readFile(workspaceFile(), 'utf8'))
}

/**
 * Replace the persisted Workspace document atomically, so a crash never leaves
 * a half-written sidebar catalog behind.
 * @param doc - complete document to write.
 */
async function writeWorkspaceFile(doc) {
	const target = workspaceFile()
	await mkdir(dirname(target), { recursive: true })
	const temporary = `${target}.${process.pid}.tmp`
	await writeFile(temporary, `${JSON.stringify(doc, undefined, 2)}\n`, 'utf8')
	await rename(temporary, target)
}

/**
 * List every Workspace record that may carry Sessions, preferring the live
 * domain (which keeps Host memory and disk in step) over the document.
 * @param ctx - Host context.
 * @returns the source kind, the domain when live, and the records.
 */
async function listWorkspaces(ctx) {
	const domain = workspaceDomain(ctx)
	if (domain !== undefined) {
		const records = []
		try {
			for (const [key, value] of domain.table(WORKSPACE_TABLE).entries()) records.push({ key, value })
			return { kind: 'domain', domain, records }
		} catch {
			return { kind: 'none', domain: undefined, records: [] }
		}
	}
	try {
		const doc = await readWorkspaceFile()
		const table = doc?.tables?.workspaces
		const records = table !== null && typeof table === 'object'
			? Object.entries(table).map(([key, value]) => ({ key, value }))
			: []
		return { kind: 'file', doc, records }
	} catch {
		return { kind: 'none', domain: undefined, records: [] }
	}
}

/**
 * Find the Workspace record that lists one Session.
 * @param ctx - Host context.
 * @param id - Session id.
 * @returns the workspace key, path, title and the listed index.
 */
async function findWorkspace(ctx, id) {
	const snapshot = await listWorkspaces(ctx)
	for (const record of snapshot.records) {
		const listed = Array.isArray(record.value?.sessionIds) ? record.value.sessionIds : []
		const index = listed.indexOf(id)
		if (index < 0) continue
		return {
			key: record.key,
			path: typeof record.value?.path === 'string' ? record.value.path : '',
			title: typeof record.value?.title === 'string' ? record.value.title : '',
			index,
		}
	}
	return undefined
}

/**
 * Remove one Session id from the global pin/archive lists, in place.
 * @param global - the domain's global record.
 * @param id - Session id.
 * @returns whether anything changed.
 */
function dropGlobalId(global, id) {
	let changed = false
	for (const field of ['pinnedSessionIds', 'archivedSessionIds']) {
		const list = global?.[field]
		if (!Array.isArray(list) || !list.includes(id)) continue
		global[field] = list.filter((value) => value !== id)
		changed = true
	}
	return changed
}

/**
 * Drop one Session id from the Workspace catalog. A Session whose log directory
 * is already gone still leaves a sidebar row behind through this catalog, and
 * that row cannot be moved to the trash by moving files alone.
 * @param ctx - Host context.
 * @param id - Session id.
 * @returns the detached workspace reference, or `undefined` when uncatalogued.
 */
async function detachSession(ctx, id) {
	const found = await findWorkspace(ctx, id)
	if (found === undefined) return undefined
	const domain = workspaceDomain(ctx)
	if (domain !== undefined) {
		try {
			await domain.table(WORKSPACE_TABLE).update(found.key, (current) => ({
				...current,
				sessionIds: (Array.isArray(current?.sessionIds) ? current.sessionIds : []).filter((value) => value !== id),
			}))
			const global = domain.global.get()
			if (global !== null && typeof global === 'object' && dropGlobalId(global, id)) {
				await domain.global.set(global)
			}
			return found
		} catch (error) {
			ctx.logger?.warn?.(`session-trash: 工作区存储更新失败，改写 workspace.json: ${error?.message ?? error}`)
		}
	}
	const doc = await readWorkspaceFile()
	const record = doc?.tables?.workspaces?.[found.key]
	if (record === undefined || typeof record !== 'object') return undefined
	record.sessionIds = (Array.isArray(record.sessionIds) ? record.sessionIds : []).filter((value) => value !== id)
	dropGlobalId(doc?.global, id)
	await writeWorkspaceFile(doc)
	return found
}

/**
 * Put one Session id back into the Workspace record it came from.
 * @param ctx - Host context.
 * @param meta - trash entry metadata carrying `workspaceId` and `index`.
 * @returns whether the record accepted the id.
 */
async function attachSession(ctx, meta) {
	const key = typeof meta?.workspaceId === 'string' ? meta.workspaceId : ''
	const id = typeof meta?.id === 'string' ? meta.id : ''
	if (key.length === 0 || id.length === 0) return false
	const requested = Number.isInteger(meta?.index) ? meta.index : -1
	const place = (listed) => {
		const at = requested >= 0 && requested <= listed.length ? requested : listed.length
		listed.splice(at, 0, id)
		return listed
	}
	const domain = workspaceDomain(ctx)
	if (domain !== undefined) {
		try {
			const table = domain.table(WORKSPACE_TABLE)
			const current = table.get(key)
			if (current === undefined) return false
			const listed = Array.isArray(current?.sessionIds) ? [...current.sessionIds] : []
			if (listed.includes(id)) return true
			await table.put(key, { ...current, sessionIds: place(listed) })
			return true
		} catch (error) {
			ctx.logger?.warn?.(`session-trash: 工作区存储回写失败，改写 workspace.json: ${error?.message ?? error}`)
		}
	}
	const doc = await readWorkspaceFile()
	const record = doc?.tables?.workspaces?.[key]
	if (record === undefined || typeof record !== 'object') return false
	const listed = Array.isArray(record.sessionIds) ? [...record.sessionIds] : []
	if (listed.includes(id)) return true
	record.sessionIds = place(listed)
	await writeWorkspaceFile(doc)
	return true
}

/**
 * Measure one directory tree.
 * @param dir - absolute directory.
 * @returns byte total and file count.
 */
async function measure(dir) {
	let bytes = 0
	let files = 0
	const entries = await readdir(dir, { withFileTypes: true, recursive: true })
	for (const entry of entries) {
		if (!entry.isFile()) continue
		try {
			bytes += (await stat(join(entry.parentPath ?? entry.path, entry.name))).size
			files += 1
		} catch {
			// A concurrent write may remove a file mid-scan.
		}
	}
	return { bytes, files }
}

/**
 * List one trash entry's metadata.
 * @param entryDir - absolute trash entry directory.
 * @returns the parsed metadata, or `undefined` when unreadable.
 */
async function readEntry(entryDir) {
	try {
		const meta = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
		if (typeof meta?.id !== 'string' || typeof meta?.entry !== 'string') return undefined
		return meta
	} catch {
		return undefined
	}
}

/**
 * List every trash entry, newest first.
 * @returns the entries.
 */
async function listEntries() {
	let names
	try {
		names = await readdir(trashRoot(), { withFileTypes: true })
	} catch {
		return []
	}
	const entries = []
	for (const item of names) {
		if (!item.isDirectory()) continue
		const entryDir = join(trashRoot(), item.name)
		const meta = await readEntry(entryDir)
		if (meta === undefined) continue
		entries.push({
			entry: meta.entry,
			id: meta.id,
			kind: meta.kind === 'catalog' ? 'catalog' : 'session',
			project: typeof meta.project === 'string' ? meta.project : '',
			cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
			title: typeof meta.title === 'string' ? meta.title : '',
			trashedAt: typeof meta.trashedAt === 'string' ? meta.trashedAt : '',
			bytes: typeof meta.bytes === 'number' ? meta.bytes : 0,
			files: typeof meta.files === 'number' ? meta.files : 0,
		})
	}
	entries.sort((left, right) => String(right.trashedAt).localeCompare(String(left.trashedAt)))
	return entries
}

/**
 * Move one Session into the trash. A Session that never wrote a log still owns a
 * sidebar row through the Workspace catalog; that row is detachable on its own,
 * so an untitled empty Session can be removed too.
 * @param ctx - Host context, used to refuse a running Session and to update the
 * Workspace catalog in place.
 * @param id - Session id.
 * @returns the created entry.
 */
async function trash(ctx, id) {
	const found = await findSessionDir(id)
	let workspace = await findWorkspace(ctx, id)
	if (found === undefined && workspace === undefined) {
		const error = new Error(`找不到会话 ${id} 的日志目录，也没有任何工作区登记，可能已被清理。`)
		error.code = 'SESSION_NOT_FOUND'
		throw error
	}
	if (isRunning(ctx, id)) {
		const error = new Error('该会话正在运行，请先停止后再移入回收站。')
		error.code = 'SESSION_RUNNING'
		throw error
	}
	const kind = found === undefined ? 'catalog' : 'session'
	const cached = await readCachedMeta(id)
	const size = found === undefined ? { bytes: 0, files: 0 } : await measure(found.dir)
	const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
	const entry = `${stamp}-${id}`
	const entryDir = join(trashRoot(), entry)
	await mkdir(entryDir, { recursive: true })
	let detached = false
	try {
		if (found !== undefined) await rename(found.dir, join(entryDir, 'session'))
		if (kind === 'catalog') {
			workspace = await detachSession(ctx, id)
			if (workspace === undefined) {
				const error = new Error('这个空会话没有日志目录，也无法从工作区列表移除（工作区目录不可写）。')
				error.code = 'WORKSPACE_UNAVAILABLE'
				throw error
			}
			detached = true
		} else {
			try {
				workspace = (await detachSession(ctx, id)) ?? workspace
				detached = true
			} catch (error) {
				ctx.logger?.warn?.(`session-trash: 未能把 ${id} 从工作区列表移除: ${error?.message ?? error}`)
			}
		}
		await writeFile(join(entryDir, 'meta.json'), `${JSON.stringify({
			entry,
			id,
			kind,
			project: found?.project ?? '',
			cwd: cached.cwd.length > 0 ? cached.cwd : (workspace?.path ?? ''),
			title: cached.title,
			workspaceId: workspace?.key ?? '',
			index: workspace?.index ?? -1,
			bytes: size.bytes,
			files: size.files,
			trashedAt: new Date().toISOString(),
		}, undefined, 2)}\n`, 'utf8')
	} catch (error) {
		if (detached && workspace !== undefined) {
			try {
				await attachSession(ctx, { id, workspaceId: workspace.key, index: workspace.index })
			} catch {
				// The caller still receives the original failure.
			}
		}
		if (found !== undefined) {
			try {
				await rename(join(entryDir, 'session'), found.dir)
			} catch {
				// Best-effort rollback: the entry directory is removed below.
			}
		}
		await rm(entryDir, { recursive: true, force: true })
		throw error
	}
	await rm(join(cacheRoot(), `${id}.json`), { force: true })
	return { entry, id, kind, project: found?.project ?? '', bytes: size.bytes, files: size.files }
}

/**
 * Move one trashed Session back to its original project directory, or put an
 * empty Session back into its Workspace catalog when it never had a directory.
 * @param ctx - Host context.
 * @param entryName - trash entry directory name.
 * @returns the restored Session id.
 */
async function restore(ctx, entryName) {
	if (!SAFE_SEGMENT.test(entryName)) {
		const error = new Error('非法的回收站条目。')
		error.code = 'INVALID_ENTRY'
		throw error
	}
	const entryDir = join(trashRoot(), entryName)
	const meta = await readEntry(entryDir)
	if (meta === undefined) {
		const error = new Error('回收站条目不存在或已损坏。')
		error.code = 'ENTRY_NOT_FOUND'
		throw error
	}
	const hasSessionDir = await stat(join(entryDir, 'session')).then(() => true, () => false)
	if (!hasSessionDir) {
		if (!(await attachSession(ctx, meta))) {
			const error = new Error('这个空会话原来的工作区已不存在，无法放回列表；可以直接「彻底删除」。')
			error.code = 'ENTRY_NOT_RESTORABLE'
			throw error
		}
		await rm(entryDir, { recursive: true, force: true })
		return { id: meta.id, project: typeof meta.project === 'string' ? meta.project : '', kind: 'catalog' }
	}
	if (typeof meta.project !== 'string' || !SAFE_SEGMENT.test(meta.project)) {
		const error = new Error('回收站条目缺少可还原的项目目录信息。')
		error.code = 'INVALID_ENTRY'
		throw error
	}
	const target = join(sessionsRoot(), meta.project, meta.id)
	try {
		await stat(target)
		const error = new Error('原位置已存在同名会话，未覆盖。请先清理冲突的会话目录。')
		error.code = 'TARGET_EXISTS'
		throw error
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
	await mkdir(join(sessionsRoot(), meta.project), { recursive: true })
	await rename(join(entryDir, 'session'), target)
	try {
		await attachSession(ctx, meta)
	} catch (error) {
		ctx.logger?.warn?.(`session-trash: 已还原日志，但未能放回工作区列表: ${error?.message ?? error}`)
	}
	await rm(entryDir, { recursive: true, force: true })
	return { id: meta.id, project: meta.project, kind: 'session' }
}

/**
 * Permanently delete one trash entry.
 * @param entryName - trash entry directory name.
 * @returns the removed entry name.
 */
async function purge(entryName) {
	if (!SAFE_SEGMENT.test(entryName)) {
		const error = new Error('非法的回收站条目。')
		error.code = 'INVALID_ENTRY'
		throw error
	}
	await rm(join(trashRoot(), entryName), { recursive: true, force: true })
	return { entry: entryName }
}

/** Permanently delete every trash entry. */
async function empty() {
	await rm(trashRoot(), { recursive: true, force: true })
	return { emptied: true }
}

/**
 * Report whether the Agent of one Session is currently running, so a live log is
 * never moved out from under its writer.
 * @param ctx - Host context.
 * @param id - Session id.
 * @returns whether the Session has a running Agent.
 */
function isRunning(ctx, id) {
	try {
		const agents = Reflect.get(ctx, 'agents') ?? ctx.get?.('agents')
		const agent = agents?.get?.(id)
		return agent?.status === 'running'
	} catch {
		return false
	}
}

/** Serialise mutations so concurrent clicks never interleave. */
let tail = Promise.resolve()

/**
 * @param task - one mutation.
 * @returns its result once every earlier mutation settled.
 */
function serial(task) {
	const run = tail.then(task, task)
	tail = run.then(() => undefined, () => undefined)
	return run
}

/**
 * Register the trash route.
 * @param ctx - Host context carrying the fetch route registry.
 */
function apply(ctx) {
	const connection = Reflect.get(ctx, 'connection') ?? ctx.get?.('connection')
	if (connection === undefined) return
	try {
		registerRoutes(ctx, connection)
	} catch (error) {
		ctx.logger?.warn?.(`session-trash: route registration failed: ${error?.message ?? error}`)
	}
}

/**
 * Register the trash route on one fetch registry.
 * @param ctx - Host context.
 * @param connection - the connection service owning the fetch registry.
 */
function registerRoutes(ctx, connection) {
	connection.fetch.register({
		path: ROUTE_PATH,
		methods: ['GET', 'POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			try {
				if (request.method === 'GET') {
					const items = await listEntries()
					return json({
						ok: true,
						items,
						totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
					})
				}
				let body
				try {
					body = await request.json()
				} catch {
					return fail(400, 'BAD_JSON', '请求体不是合法 JSON。')
				}
				const action = typeof body?.action === 'string' ? body.action : ''
				if (action === 'empty') return json({ ok: true, ...(await serial(empty)) })
				if (action === 'trash') {
					const id = String(body?.sessionId ?? '')
					if (id.length === 0) return fail(400, 'BAD_REQUEST', '缺少 sessionId。')
					return json({ ok: true, ...(await serial(() => trash(ctx, id))) })
				}
				if (action === 'restore') {
					const entry = String(body?.entry ?? '')
					if (entry.length === 0) return fail(400, 'BAD_REQUEST', '缺少 entry。')
					return json({ ok: true, ...(await serial(() => restore(ctx, entry))) })
				}
				if (action === 'purge') {
					const entry = String(body?.entry ?? '')
					if (entry.length === 0) return fail(400, 'BAD_REQUEST', '缺少 entry。')
					return json({ ok: true, ...(await serial(() => purge(entry))) })
				}
				return fail(400, 'UNKNOWN_ACTION', `未知操作 ${action || '(空)'}。`)
			} catch (error) {
				const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
				const status = code === 'SESSION_NOT_FOUND' || code === 'ENTRY_NOT_FOUND'
					? 404
					: code === 'SESSION_RUNNING'
						|| code === 'TARGET_EXISTS'
						|| code === 'WORKSPACE_UNAVAILABLE'
						|| code === 'ENTRY_NOT_RESTORABLE'
						? 409
						: 500
				ctx.logger?.warn?.(`session-trash: ${code}: ${error?.message ?? error}`)
				return fail(status, code, String(error?.message ?? error))
			}
		},
	})
}

export { apply, inject, name }
