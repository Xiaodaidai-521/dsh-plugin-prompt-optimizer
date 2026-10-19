window.__ModuleLoader__.load({
	id: "dsh-plugin-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** Hard dependency: without the slot registry there is no button to place. */
		const inject = ["slots"];

		/** Route prefix owned by this bundle's host half. */
		const BASE = "/prompt-optimizer";
		/** Id of the injected stylesheet element (also the cleanup handle). */
		const STYLE_ID = "dsh-prompt-optimizer-style";
		/** This entry's cell id inside the composer's right-hand tool row. */
		const ENTRY_ID = "prompt-optimizer";
		/**
		 * The button lives INSIDE the composer card: `conversation.input.right` is
		 * the compact control row before the submit action, i.e. the right-hand end
		 * of the input box. It is a real row of the card, not an overlay, so no
		 * amount of typed text can ever sit underneath it.
		 */
		const SLOT = "conversation.input.right";
		/** Ascending across that row; keeps the icon adjacent to the submit action. */
		const ENTRY_ORDER = 30;

		const EMPTY_STATE = { draft: "", phase: "plain" };

		/**
		 * Template blanks a model (or an older host half) may still emit. Defense in
		 * depth: placeholder text must never reach the user's draft, whatever build
		 * is answering the request.
		 */
		const PLACEHOLDER_PATTERN = /\{\{|\}\}|【\s*待补充|\[\s*待补充|<\s*待补充|待补充\s*[:：]|\bTBD\b/;

		/**
		 * Why a rewrite was not applied. Kept on the hover title so a refusal is
		 * explainable instead of mysterious.
		 */
		const NO_CHANGE_DETAILS = {
			"already-clear": "这段内容本身已经够清楚，已保留原文",
			"placeholder-output": "模型只给出了模板占位符，已保留原文",
			"preserve-check": "改写会丢掉原文里的数字、路径或代码标识，已保留原文",
			"expansion-guard": "改写把内容扩写太多，已保留原文",
			"scaffold-guard": "改写会给原文套上模板章节，已保留原文",
			"budget-exhausted": "本次优化调用预算已用尽，已保留原文",
			"judge-rejected": "评审认为候选没有实质改善，已保留原文",
		};

		const CSS = [
			/* Only the busy pulse is stylesheet business. Geometry, colour and the
			   absence of any box are inline styles (see glyphStyle) because a
			   document-level rule can be outranked or dropped once another plugin
			   (e.g. a wallpaper) repaints the surface behind the composer, and the
			   native button chrome then shows up as a grey block. */
			".dsh-po-icon{display:block;}",
			".dsh-po-icon.is-busy{animation:dsh-po-pulse .9s ease-in-out infinite;}",
			"@keyframes dsh-po-pulse{0%,100%{opacity:.35;transform:scale(.9);}50%{opacity:1;transform:scale(1);}}",
			"@media (prefers-reduced-motion:reduce){.dsh-po-icon.is-busy{animation:none;opacity:.6;}}",
		].join("");

		/**
		 * Project the published input state onto the two fields this button needs.
		 * @param {any} state - published InputState (or undefined).
		 * @returns {{ draft: string, phase: string }} projection.
		 */
		function projectInput(state) {
			if (!state || typeof state !== "object") return EMPTY_STATE;
			const draft = typeof state.draft === "string" ? state.draft : "";
			const phase = typeof state.phase === "string" ? state.phase : "plain";
			return { draft: draft, phase: phase };
		}

		/**
		 * Equality for {@link projectInput} so the selector hook skips unrelated state.
		 * @param {any} a - previous projection.
		 * @param {any} b - next projection.
		 * @returns {boolean} whether both projections are equivalent.
		 */
		function sameInput(a, b) {
			if (a === b) return true;
			if (!a || !b) return false;
			return a.draft === b.draft && a.phase === b.phase;
		}

		/**
		 * Mount this bundle's stylesheet once; the returned disposer removes it.
		 * @returns {(() => void) | undefined} cleanup, or undefined when no DOM exists.
		 */
		function installStyle() {
			if (typeof document === "undefined" || !document || !document.head) return undefined;
			const existing = document.getElementById(STYLE_ID);
			if (!existing) {
				const element = document.createElement("style");
				element.id = STYLE_ID;
				element.textContent = CSS;
				document.head.appendChild(element);
			}
			return () => {
				const element = document.getElementById(STYLE_ID);
				if (element && element.parentNode) element.parentNode.removeChild(element);
			};
		}

		/**
		 * Trim one server-supplied message to something this row can show.
		 * @param {any} value - raw message.
		 * @param {string} fallback - message used when the value is unusable.
		 * @returns {string} display text.
		 */
		function shortMessage(value, fallback) {
			const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
			return text.length > 160 ? text.slice(0, 160) + "…" : text;
		}

		/**
		 * Inline style for one glyph button.
		 *
		 * Deliberately inline instead of stylesheet-driven: the composer's own
		 * controls (model selector, submit) hard-code `border:none` and a
		 * transparent fill for the same reason. A document-level stylesheet can be
		 * outranked or lost once another plugin paints the surface behind the
		 * composer — and then the browser's native button chrome reappears as a
		 * grey box that clashes with the wallpaper. Inline wins unconditionally.
		 * @param {boolean} hovered - pointer is over the control.
		 * @param {boolean} disabled - control cannot run right now.
		 * @param {boolean} busy - a rewrite is in flight.
		 * @returns {any} React style object.
		 */
		function glyphStyle(hovered, disabled, busy) {
			return {
				appearance: "none",
				WebkitAppearance: "none",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 20,
				height: 20,
				padding: 0,
				margin: 0,
				border: "none",
				borderRadius: 999,
				background: "none",
				backgroundColor: "transparent",
				backgroundImage: "none",
				boxShadow: "none",
				color: "inherit",
				cursor: disabled ? "default" : "pointer",
				flex: "0 0 auto",
				lineHeight: 1,
				opacity: disabled ? 0.28 : hovered || busy ? 1 : 0.55,
				transition: "opacity .15s ease",
			};
		}

		/**
		 * Inline SVG glyph for the control. Icon-only by design: the row carries no
		 * copy of its own, so nothing in it can be mistaken for composer text.
		 * @param {boolean} busy - whether a rewrite is in flight.
		 * @returns {any} React node.
		 */
		function sparkleIcon(busy) {
			return React.createElement(
				"svg",
				{
					className: busy ? "dsh-po-icon is-busy" : "dsh-po-icon",
					viewBox: "0 0 24 24",
					width: 14,
					height: 14,
					style: { display: "block", width: 14, height: 14 },
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					focusable: "false",
				},
				React.createElement("path", { d: "M12 3.4l1.9 5L19 10.3l-5.1 1.9L12 17.2l-1.9-5L5 10.3l5.1-1.9z" }),
				React.createElement("path", { d: "M18.7 15.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" }),
			);
		}

		/**
		 * Undo glyph. The revert action is icon-only for the same reason the
		 * trigger is: this row must not grow text next to the model selector.
		 * @returns {any} React node.
		 */
		function undoIcon() {
			return React.createElement(
				"svg",
				{
					className: "dsh-po-icon",
					viewBox: "0 0 24 24",
					width: 14,
					height: 14,
					style: { display: "block", width: 14, height: 14 },
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.8,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					focusable: "false",
				},
				React.createElement("path", { d: "M4.5 9.5h10a5 5 0 0 1 0 10H9" }),
				React.createElement("path", { d: "M8.5 5.5 4.5 9.5l4 4" }),
			);
		}

		/**
		 * Icon-only rewrite control, rendered inside the composer's tool row.
		 * Reads the draft, rewrites it through the host half, writes the result
		 * back into the same draft, and offers one-step undo.
		 * @param {any} props - composed slot props (standard kit + global seat).
		 * @returns {any} React node.
		 */
		function PromptOptimizerButton(props) {
			const composed = props || {};
			const inputActions = composed.inputActions;
			const useInput = typeof composed.useInput === "function" ? composed.useInput : null;
			const subscribed = useInput ? useInput(projectInput, sameInput) : null;
			const input = subscribed || projectInput(composed.input);
			const latestInputRef = React.useRef(input);
			latestInputRef.current = input;

			const [busy, setBusy] = React.useState(false);
			const [hovered, setHovered] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [undoText, setUndoText] = React.useState(null);
			const busyRef = React.useRef(false);
			const aliveRef = React.useRef(true);
			const controllerRef = React.useRef(null);

			React.useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
					const controller = controllerRef.current;
					if (controller) {
						try {
							controller.abort();
						} catch {
							// Already settled.
						}
					}
				};
			}, []);

			const canWrite = !!(inputActions && typeof inputActions.setDraft === "function");
			const blank = !input.draft || !input.draft.trim();
			const canRun = canWrite && !busy && !blank && input.phase === "plain";

			/**
			 * Ask the host half for a rewrite and write it back into the draft.
			 */
			const run = async () => {
				if (busyRef.current || !canWrite || !canRun) return;
				const original = input.draft;
				busyRef.current = true;
				setBusy(true);
				setNotice({ kind: "info", text: "优化中", dots: true });

				const controller = typeof AbortController === "function" ? new AbortController() : null;
				controllerRef.current = controller;
				const started = Date.now();

				try {
					const response = await fetch(BASE + "/optimize", {
						method: "POST",
						headers: { "content-type": "application/json" },
						cache: "no-store",
						credentials: "same-origin",
						body: JSON.stringify({ text: original }),
						...(controller ? { signal: controller.signal } : {}),
					});

					let data = null;
					try {
						data = await response.json();
					} catch {
						data = null;
					}

					if (!aliveRef.current) return;

					if (!response.ok || !data || data.ok !== true) {
						const reason = data && (data.error || data.message);
						const fallback = !data
							? "宿主没有返回 JSON：插件的后端半边可能没有加载"
							: "优化失败（HTTP " + response.status + "）";
						setNotice({ kind: "error", text: shortMessage(reason || fallback, "优化失败") });
						return;
					}

					// Only apply to the exact draft that this button click captured.
					// This check never schedules optimization on input or submission.
					const latest = latestInputRef.current;
					if (latest.draft !== original || latest.phase !== "plain") {
						setUndoText(null);
						setNotice({ kind: "info", text: "草稿已变化", detail: "已保留当前输入，本次优化结果未写入" });
						return;
					}

					const optimized = typeof data.text === "string" ? data.text.trim() : "";
					if (!optimized) {
						setNotice({ kind: "error", text: "模型没有返回内容，请重试" });
						return;
					}

					if (PLACEHOLDER_PATTERN.test(optimized)) {
						setUndoText(null);
						setNotice({
							kind: "info",
							text: "无需优化",
							detail: "模型返回了带占位符的模板，已保留原文",
						});
						return;
					}

					if (data.changed === false) {
						setUndoText(null);
						setNotice({
							kind: "info",
							text: "无需优化",
							detail:
								NO_CHANGE_DETAILS[String(data.reason || "")] || "这段内容本身已经够清楚，已保留原文",
						});
						return;
					}

					inputActions.setDraft(optimized);
					setUndoText(original);
					const seconds = ((Date.now() - started) / 1000).toFixed(1);
					const model = data.model ? String(data.model) : "";
					const evaluation = data.evaluation;
					const detail = model ? "用 " + model + " 改写完成 · " + seconds + "s" : "改写完成 · " + seconds + "s";
					setNotice({
						kind: "info",
						text: "已改写 " + seconds + "s",
						detail:
							evaluation && evaluation.judgeReason
								? detail + " · 评审：" + evaluation.judgeReason
								: detail,
					});
				} catch (error) {
					if (!aliveRef.current) return;
					if (error && error.name === "AbortError") {
						setNotice(null);
						return;
					}
					setNotice({
						kind: "error",
						text: shortMessage(error && error.message, "请求没有完成（宿主可能未运行）"),
					});
				} finally {
					busyRef.current = false;
					controllerRef.current = null;
					if (aliveRef.current) setBusy(false);
				}
			};

			/**
			 * Restore the draft as it was before the last successful optimization.
			 */
			const undo = () => {
				if (!canWrite || undoText === null) return;
				inputActions.setDraft(undoText);
				setUndoText(null);
				setNotice({ kind: "info", text: "已撤销", detail: "已恢复优化前的输入" });
			};

			/**
			 * Only a failure may draw text in this row: a silently refused click
			 * would be unexplainable. Every other outcome (无需优化 / 已改写 / 已撤销)
			 * lives in the tooltip instead, so the toolbar stays glyph-only and the
			 * composer's material is never covered by a label.
			 */
			const status = notice && notice.kind === "error" ? notice : null;
			const statusHint = notice ? String(notice.detail || notice.text || "") : "";
			const baseTitle = !canWrite
				? "当前输入框不可写，无法优化"
				: blank
					? "先在输入框里写一点内容"
					: input.phase !== "plain"
						? "当前输入框正在提交或执行命令，稍后再试"
						: "用当前模型改写输入框里的这段内容";

			const title = !status && statusHint ? baseTitle + " · " + statusHint : baseTitle;

			const children = [];

			if (status) {
				children.push(
					React.createElement(
						"span",
						{
							key: "note",
							className: "dsh-po-note is-error",
							role: "status",
							title: status.detail || status.text,
							style: {
								fontSize: 11,
								lineHeight: 1,
								maxWidth: 140,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								color: "#e5484d",
							},
						},
						status.text,
					),
				);
			}

			if (undoText !== null) {
				children.push(
					React.createElement(
						"button",
						{
							key: "undo",
							type: "button",
							className: "dsh-po-undo",
							title: "撤销这次优化，恢复原来的输入",
							"aria-label": "撤销这次优化，恢复原来的输入",
							style: glyphStyle(false, false, false),
							onMouseDown: (event) => event.preventDefault(),
							onClick: undo,
						},
						undoIcon(),
					),
				);
			}

			children.push(
				React.createElement(
					"button",
					{
						key: "run",
						type: "button",
						className: "dsh-po-btn",
						disabled: !canRun,
						title: title,
						"aria-label": title,
						"aria-busy": busy ? "true" : "false",
						style: glyphStyle(hovered, !canRun, busy),
						onMouseDown: (event) => event.preventDefault(),
						onClick: run,
						onMouseEnter: () => setHovered(true),
						onMouseLeave: () => setHovered(false),
					},
					sparkleIcon(busy),
				),
			);

			return React.createElement(
				"span",
				{
					className: "dsh-po-inline",
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 2,
						flex: "0 0 auto",
						padding: 0,
						margin: 0,
						border: "none",
						background: "none",
						backgroundColor: "transparent",
						boxShadow: "none",
						lineHeight: 1,
					},
				},
				children,
			);
		}

		/**
		 * Mount the icon-only control into the composer's right-hand tool row.
		 * @param {any} ctx - client Cordis context (slots in scope).
		 */
		function apply(ctx) {
			const slots = ctx.get("slots") || ctx.slots;
			if (!slots || typeof slots.register !== "function") return;

			ctx.effect(() => installStyle() || undefined);

			// `inject` defers registration until the owning composer bar has
			// declared `conversation.input.right`, so load order never matters.
			if (typeof slots.inject === "function") {
				slots.inject(SLOT, () =>
					slots.register({ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, PromptOptimizerButton),
				);
				return;
			}

			slots.register({ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, PromptOptimizerButton);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
