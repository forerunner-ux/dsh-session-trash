/**
 * Offline harness for the session-trash browser half: loads the bundle the same
 * way the page loader does, then drives the registrations with a fake context
 * and a minimal hooks runtime.
 */
import { pathToFileURL } from 'node:url'

let loaded
globalThis.window = {
	__ModuleLoader__: {
		load: (entry) => {
			loaded = entry
		},
	},
}

const requests = []
const notifications = []
let nextResponse = { ok: true, items: [] }
globalThis.fetch = async (input, init) => {
	requests.push({ input, init, body: init?.body ? JSON.parse(init.body) : undefined })
	const payload = typeof nextResponse === 'function' ? nextResponse() : nextResponse
	return {
		ok: true,
		status: 200,
		json: async () => payload,
	}
}

await import(pathToFileURL(process.argv[2]).href)

function assert(condition, label) {
	if (!condition) throw new Error(`FAILED: ${label}`)
	console.log(`  ok  ${label}`)
}

// ---------------------------------------------------------------- module shape
assert(loaded.id === 'dsh-session-trash', 'bundle id')
const factory = loaded.factory
assert(typeof factory === 'function', 'factory present')

// ------------------------------------------------------------- minimal modules
function createElement(type, props, ...children) {
	return { type, props: { ...(props ?? {}), children: children.length > 0 ? children : (props?.children ?? []) } }
}

let hookSlot = 0
const hooks = []
const React = {
	createElement,
	useState(initial) {
		const index = hookSlot++
		if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
		const set = (next) => {
			hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
		}
		return [hooks[index], set]
	},
	useEffect(fn) {
		hookSlot++
		fn()
	},
	useCallback(fn) {
		hookSlot++
		return fn
	},
}

const exportsObject = factory((specifier) => {
	if (specifier === 'react') return React
	throw new Error(`unexpected require: ${specifier}`)
})
assert(typeof exportsObject.apply === 'function', 'apply export')
assert(Array.isArray(exportsObject.inject), 'inject export')
console.log('  inject:', exportsObject.inject.join(', '))

// ------------------------------------------------------------------ fake context
const menuRegistrations = []
const slotRegistrations = []
let sessionRefreshCalls = 0

function runGeneratorOrValue(value) {
	if (value && typeof value.next === 'function') {
		let step = value.next()
		while (!step.done) step = value.next()
	}
	return value
}

const contextMenus = {
	notify: (text, success) => {
		notifications.push({ text, success })
	},
	register: (registration) => {
		menuRegistrations.push(registration)
		return () => {}
	},
}

const ctx = {
	get: (name) => {
		if (name === 'sessions') return { refresh: async () => { sessionRefreshCalls++ } }
		if (name === 'contextMenus') return contextMenus
		return undefined
	},
	contextMenus,
	effect: (fn) => {
		const dispose = fn()
		return typeof dispose === 'function' ? dispose : () => {}
	},
	slots: {
		inject: (name, fn) => runGeneratorOrValue(fn()),
		register: (registration, component) => {
			slotRegistrations.push({ registration, component })
			return () => {}
		},
	},
}

exportsObject.apply(ctx)
assert(menuRegistrations.length === 1, 'one menu registration')
const menu = menuRegistrations[0]
assert(menu.target === 'session', 'menu targets session rows')
const entries = menu.resolve({ sessionId: 'session-x', displayTitle: 'demo' })
assert(Array.isArray(entries) && entries.length === 1, 'menu resolves one entry')
assert(entries[0].label === '移入回收站', 'menu label')
assert(entries[0].danger === true, 'menu entry is dangerous')
assert(slotRegistrations.some((item) => item.registration.name === 'main' && item.registration.key === 'session-trash'), 'main panel slot')
assert(slotRegistrations.some((item) => item.registration.name === 'sidebar.panellist' && item.registration.id === 'session-trash'), 'sidebar panel slot')
const iconRegistration = slotRegistrations.find((item) => item.registration.name === 'sidebar.panellist')
assert(iconRegistration.registration.label() === '回收站', 'panel label')
const icon = iconRegistration.component({ size: 16, active: false })
assert(icon.type === 'svg', 'panel icon is an svg')

// --------------------------------------------------------------- menu action run
nextResponse = { ok: true, entry: 'x', id: 'session-x' }
await entries[0].run()
await new Promise((resolve) => setTimeout(resolve, 20))
assert(requests.at(-1).body.action === 'trash' && requests.at(-1).body.sessionId === 'session-x', 'menu posts trash')
assert(sessionRefreshCalls === 1, 'menu refreshes the Session list')
assert(notifications.length === 1 && notifications[0].success === true, 'menu shows a success toast')
assert(notifications[0].text.includes('已移入回收站'), 'toast names the outcome')

// -------------------------------------------------------------- failure toast
nextResponse = { ok: false, error: { code: 'SESSION_RUNNING', message: '该会话正在运行' } }
globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'SESSION_RUNNING', message: '该会话正在运行' } }) })
await entries[0].run()
assert(notifications.at(-1).success === false, 'failure toast is an error tone')
assert(notifications.at(-1).text.includes('该会话正在运行'), 'failure toast carries the message')

// ------------------------------------------------------------------ panel render
globalThis.fetch = async (input, init) => {
	requests.push({ input, init, body: init?.body ? JSON.parse(init.body) : undefined })
	return { ok: true, status: 200, json: async () => nextResponse }
}
nextResponse = {
	ok: true,
	totalBytes: 2048,
	items: [
		{ entry: 'e-1', id: 'session-y', kind: 'session', project: '--E-DS--', cwd: 'E:\\DS', title: '被删掉的会话', trashedAt: '2026-11-05T07:00:00.000Z', bytes: 2048, files: 1 },
		{ entry: 'e-2', id: 'session-ghost', kind: 'catalog', project: '', cwd: 'C:\\Users\\lenovo\\Desktop\\毕设', title: '', trashedAt: '2026-11-05T06:00:00.000Z', bytes: 0, files: 0 },
	],
}
const panelRegistration = slotRegistrations.find((item) => item.registration.name === 'main')
hooks.length = 0
hookSlot = 0
const tree = panelRegistration.component({})
assert(tree && tree.type === 'div', 'panel renders a div')

const collect = (node, out = []) => {
	if (node === null || node === undefined) return out
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node))
		return out
	}
	if (Array.isArray(node)) {
		for (const child of node) collect(child, out)
		return out
	}
	if (typeof node.props?.label === 'string') out.push(node.props.label)
	collect(node.props?.children, out)
	return out
}
const texts = collect(tree).join(' ')
assert(texts.includes('回收站'), 'panel heading')

await new Promise((resolve) => setTimeout(resolve, 30))
hookSlot = 0
const tree2 = panelRegistration.component({})
const texts2 = collect(tree2).join(' ')
assert(texts2.includes('被删掉的会话'), 'panel lists the trashed title')
assert(texts2.includes('2.0 KB') || texts2.includes('2 KB'), 'panel shows the byte size')
assert(texts2.includes('恢复') && texts2.includes('彻底删除'), 'panel offers restore and purge')
assert(texts2.includes('E:\\DS'), 'panel shows the original directory')
assert(texts2.includes('（未命名会话）'), 'panel labels a titleless entry')
assert(texts2.includes('空会话（无日志）'), 'panel marks a catalog-only entry')

console.log('CLIENT HALF: all checks passed')
