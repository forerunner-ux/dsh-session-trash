window.__ModuleLoader__.load({
	id: "dsh-session-trash",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		/** Document-relative form of the Host route. */
		const ROUTE = "api/session-trash";
		/** Sidebar panel identity, keyed into the layout's `main` slot. */
		const PANEL_ID = "session-trash";
		/** Services this plugin consumes. */
		const inject = ["slots", "contextMenus", "sessions"];

		/**
		* Call the Host trash route.
		* @param init - fetch init; omit for a listing GET.
		* @returns the parsed JSON body.
		*/
		async function call(init) {
			const response = await fetch(ROUTE, {
				credentials: "same-origin",
				headers: init === undefined ? undefined : { "content-type": "application/json" },
				...init,
			});
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error(`回收站接口返回了非 JSON 响应（HTTP ${response.status}）。`);
			}
			if (!response.ok || body?.ok === false) {
				throw new Error(body?.error?.message ?? `回收站接口失败（HTTP ${response.status}）。`);
			}
			return body;
		}

		/**
		* Post one trash action.
		* @param action - action name.
		* @param fields - action fields.
		* @returns the parsed JSON body.
		*/
		function act(action, fields) {
			return call({ method: "POST", body: JSON.stringify({ action, ...fields }) });
		}

		/** Format a byte count for rows. */
		function fmtBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		}

		/** Format an ISO timestamp as local time, or the empty string. */
		function fmtTime(text) {
			if (typeof text !== "string" || text.length === 0) return "";
			const date = new Date(text);
			if (Number.isNaN(date.getTime())) return text;
			const pad = (value) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		const COLORS = {
			text: "inherit",
			dim: "rgba(140, 145, 155, 0.95)",
			line: "rgba(127, 132, 142, 0.28)",
			soft: "rgba(127, 132, 142, 0.10)",
			danger: "#e5534b",
		};

		/**
		* Sidebar entry icon.
		* @param props - slot props; the sidebar supplies an icon size.
		* @returns the trash-can glyph.
		*/
		function TrashPanelIcon({ size } = {}) {
			const px = typeof size === "number" ? size : 16;
			return h("svg", {
				width: px,
				height: px,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
				h("path", { d: "M2.5 4.5h11" }),
				h("path", { d: "M6 4.5V3.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3" }),
				h("path", { d: "M3.7 4.5l.6 8.1a.8.8 0 0 0 .8.75h5.8a.8.8 0 0 0 .8-.75l.6-8.1" }),
				h("path", { d: "M6.6 7v4.2M9.4 7v4.2" }),
			);
		}

		/**
		* One row button.
		* @param props - label, onSelect and presentation flags.
		* @returns the button.
		*/
		function RowButton({ label, onSelect, danger, disabled }) {
			return h("button", {
				type: "button",
				disabled,
				onClick: onSelect,
				style: {
					font: "inherit",
					fontSize: 12,
					padding: "4px 10px",
					borderRadius: 6,
					border: `1px solid ${danger ? "rgba(229, 83, 75, 0.55)" : COLORS.line}`,
					background: danger ? "rgba(229, 83, 75, 0.10)" : "transparent",
					color: danger ? COLORS.danger : COLORS.text,
					cursor: disabled ? "default" : "pointer",
					opacity: disabled ? 0.5 : 1,
					whiteSpace: "nowrap",
				},
			}, label);
		}

		/** Sessions client service, captured when the plugin applies. */
		let ctxSessions;

		/** Refresh the sidebar Session list when the client exposes the hook. */
		async function refreshSessions() {
			try {
				await ctxSessions?.refresh?.();
			} catch {
				// The panel reload still reflects the disk state.
			}
		}

		/** Shared toast service, captured when the plugin applies. */
		let ctxMenus;

		/**
		* Show one shared toast when the context-menu service exposes it.
		* @param text - message.
		* @param success - success tone flag.
		*/
		function notify(text, success) {
			try {
				ctxMenus?.notify?.(text, success);
			} catch {
				// A missing toast sink never blocks the operation itself.
			}
		}

		/**
		* The recycle-bin page: every trashed Session with restore and permanent
		* removal, plus an empty-trash action. Permanent removal is a two-step
		* button so no native dialog is required.
		* @returns the panel.
		*/
		function SessionTrashPage() {
			const [state, setState] = React.useState({ status: "loading", items: [], totalBytes: 0, error: "", notice: "" });
			const [busy, setBusy] = React.useState("");
			const [armed, setArmed] = React.useState("");

			const load = React.useCallback(async () => {
				setState((previous) => ({ ...previous, status: previous.items.length === 0 ? "loading" : "refreshing" }));
				try {
					const body = await call();
					setState((previous) => ({
						status: "ready",
						items: Array.isArray(body.items) ? body.items : [],
						totalBytes: body.totalBytes ?? 0,
						error: "",
						notice: previous.notice,
					}));
				} catch (error) {
					setState((previous) => ({ ...previous, status: "ready", error: String(error?.message ?? error) }));
				}
			}, []);

			React.useEffect(() => {
				load();
			}, [load]);

			const arm = React.useCallback((key) => {
				setArmed(key);
				setTimeout(() => setArmed((current) => (current === key ? "" : current)), 5000);
			}, []);

			const run = React.useCallback(async (key, task, notice) => {
				setBusy(key);
				setArmed("");
				try {
					await task();
					setState((previous) => ({ ...previous, error: "", notice: notice ?? "" }));
					if (notice) notify(notice, true);
					await load();
				} catch (error) {
					const message = String(error?.message ?? error);
					setState((previous) => ({ ...previous, error: message }));
					notify(message, false);
				} finally {
					setBusy("");
				}
			}, [load]);

			const items = state.items;
			return h("div", {
				style: {
					height: "100%",
					boxSizing: "border-box",
					padding: "18px 22px 28px",
					overflow: "auto",
					color: COLORS.text,
					fontSize: 13,
				},
			},
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" } },
					h("h2", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, "回收站"),
					h("span", { style: { color: COLORS.dim, fontSize: 12 } },
						items.length === 0 ? "暂无条目" : `${items.length} 个会话 · ${fmtBytes(state.totalBytes)}`),
					h("span", { style: { flex: 1 } }),
					h(RowButton, { label: "刷新", onSelect: () => load(), disabled: busy !== "" }),
					h(RowButton, {
						label: busy === "empty" ? "清空中…" : armed === "empty" ? "确认清空（不可恢复）" : "清空回收站",
						danger: true,
						disabled: busy !== "" || items.length === 0,
						onSelect: () => {
							if (armed !== "empty") return arm("empty");
							run("empty", () => act("empty"));
						},
					}),
				),
				h("p", { style: { margin: "0 0 14px", color: COLORS.dim, fontSize: 12, lineHeight: 1.75 } },
					"移入这里的会话已从侧边栏移除，日志文件完整保存在 ",
					h("code", { style: { fontFamily: "ui-monospace, Consolas, monospace" } }, ".dsh\\trash\\sessions"),
					" 下。点「恢复」会把它放回原来的工作区目录，随后刷新侧边栏即可重新打开。没有写过日志的空会话同样可以移入：它只从工作区列表里摘掉，恢复时重新登记。"),
				state.notice
					? h("div", {
						style: {
							margin: "0 0 14px",
							padding: "8px 12px",
							borderRadius: 8,
							border: "1px solid rgba(90, 160, 90, 0.45)",
							color: "#6bbf6b",
							fontSize: 12,
						},
					}, state.notice)
					: null,
				state.error
					? h("div", {
						style: {
							margin: "0 0 14px",
							padding: "8px 12px",
							borderRadius: 8,
							border: "1px solid rgba(229, 83, 75, 0.45)",
							color: COLORS.danger,
							fontSize: 12,
							lineHeight: 1.6,
						},
					}, state.error)
					: null,
				state.status === "loading"
					? h("div", { style: { color: COLORS.dim, fontSize: 12 } }, "加载中…")
					: items.length === 0
						? h("div", { style: { color: COLORS.dim, fontSize: 12, lineHeight: 1.8 } },
							"回收站为空。在侧边栏会话行的「⋯」菜单里选择「移入回收站」即可。")
						: h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
							items.map((item) => h("div", {
								key: item.entry,
								style: {
									border: `1px solid ${COLORS.line}`,
									borderRadius: 10,
									padding: "10px 12px",
									background: COLORS.soft,
									display: "flex",
									gap: 8,
									alignItems: "center",
									flexWrap: "wrap",
								},
							},
								h("div", { style: { flex: 1, minWidth: 220 } },
									h("div", {
										style: {
											fontWeight: 500,
											marginBottom: 3,
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
										},
										title: item.title || item.id,
									}, item.title || "（未命名会话）"),
									h("div", {
										style: {
											color: COLORS.dim,
											fontSize: 11.5,
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
										},
										title: item.cwd || item.project,
									}, [item.cwd || item.project || "（目录未知）", item.kind === "catalog" ? "空会话（无日志）" : fmtBytes(item.bytes), fmtTime(item.trashedAt)].filter(Boolean).join("  ·  ")),
								),
								h(RowButton, {
									label: busy === `restore:${item.entry}` ? "恢复中…" : "恢复",
									disabled: busy !== "",
									onSelect: () => run(`restore:${item.entry}`, async () => {
										await act("restore", { entry: item.entry });
										await refreshSessions();
									}, `已恢复「${item.title || item.id}」，如列表未更新请点「刷新」。`),
								}),
								h(RowButton, {
									label: busy === `purge:${item.entry}`
										? "删除中…"
										: armed === `purge:${item.entry}` ? "确认永久删除" : "彻底删除",
									danger: true,
									disabled: busy !== "",
									onSelect: () => {
										if (armed !== `purge:${item.entry}`) return arm(`purge:${item.entry}`);
										run(`purge:${item.entry}`, () => act("purge", { entry: item.entry }), `已永久删除「${item.title || item.id}」。`);
									},
								}),
							)),
						),
			);
		}

		/**
		* Register the trash panel, its sidebar entry, and the Session-row action.
		* @param ctx - browser plugin context.
		*/
		function apply(ctx) {
			ctxSessions = ctx.get("sessions");
			ctxMenus = ctx.get("contextMenus") ?? ctx.contextMenus;

			ctx.effect(() => ctx.contextMenus.register({
				id: "session.trash",
				target: "session",
				order: 500,
				resolve: ({ sessionId, displayTitle }) => [{
					id: "trash",
					label: "移入回收站",
					danger: true,
					separatorBefore: true,
					failureLabel: "移入回收站失败",
					run: async () => {
						try {
							await act("trash", { sessionId });
							await refreshSessions();
							notify(`已移入回收站：${displayTitle || sessionId}`, true);
						} catch (error) {
							notify(`移入回收站失败：${String(error?.message ?? error)}`, false);
						}
					},
				}],
			}), "session-trash: session menu action");

			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({ name: "main", key: PANEL_ID }, SessionTrashPage);
			});
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: () => "回收站",
			}, TrashPanelIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
