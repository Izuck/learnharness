"use client";

/**
 * The forest renderer: one canvas, one on-demand rAF loop with a dirty flag,
 * the same mechanics as GraphCanvasRenderer (d3-zoom for pan and pinch, an
 * eased cursor-anchored wheel, dpr-aware sizing, a centre-fixed
 * ResizeObserver). It is a dumb draw function over the forest model: every
 * decision about WHAT to draw at a zoom (levels, culling, the label budget,
 * the clearing layout) is a pure function in src/core/forest.ts, tested there.
 *
 * Three levels of detail (forestLevel): the world (degree names, trees as
 * dots, lit topics as specks), a region (trees, trails, topic labels) and a
 * clearing (one lit topic's ideas laid out as their chains).
 *
 * Like GraphCanvasRenderer the class is DOM-bound and exercised live. Module
 * scope stays DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import {
	CLEARING_K,
	CLEARING_R,
	LABEL_BUDGET,
	REGION_K,
	forestLevel,
	layoutClearing,
	pickLabels,
	visibleTopics,
	type ForestCamera,
	type ForestModel,
	type ForestTopic,
	type GraphChain,
	type IdeaState,
} from "@/src/core";
import { fitTransform, pickNearest } from "./graph-canvas.ts";

/** Canvas colours (CSS colour strings, read from the --lh-forest-* tokens). */
export interface ForestColors {
	bg: string;
	tree: string;
	treeEdge: string;
	light: string;
	trail: string;
	label: string;
	fogLabel: string;
}

export interface ForestCallbacks {
	onTopicClick(id: string): void;
	onIdeaClick(nodeId: string, screen: { x: number; y: number }): void;
	onStageClick(): void;
	onCameraMove(cam: ForestCamera): void;
}

/** Optional per-idea data the model itself does not carry. */
export interface ForestIdeaInfo {
	/** node id -> display name (idea labels are skipped for unnamed ids). */
	names?: ReadonlyMap<string, string>;
	/** node id -> level of knowledge (default: every idea is "seen"). */
	states?: ReadonlyMap<string, IdeaState>;
}

/** The token defaults — used for any colour a stylesheet failed to supply. */
export const DEFAULT_FOREST_COLORS: ForestColors = {
	bg: "#0e1511",
	tree: "#1d2b22",
	treeEdge: "#2a3d30",
	light: "#e8b85a",
	trail: "#b89a5e",
	label: "#9fb3a5",
	fogLabel: "#4d5f53",
};

const HELD_COLOR = "#6fbf73";
const ZOOM_EASE_MS = 45; // wheel-zoom glide: exponential-ease time constant
const CLICK_SLOP = 4; // px of pointer travel that still counts as a click
const MAX_K = 12;
const FIT_PADDING = 40;
/** Never fit tighter than this: a world of one or two topics would otherwise
 *  fill the screen with a single tree. */
const FIT_K_CAP = CLEARING_K * 0.9;
const FLY_MS = 400;
const FLY_K = CLEARING_K * 1.6;
const TREE_R = CLEARING_R * 0.9;
const MIN_TREE_PX = 1.5;
const WORLD_NAME_ALPHA = 0.55;
const NAME_PX = 22;
const LABEL_PX = 12;
const IDEA_LABEL_PX = 11;
const IDEA_R_PX = 6;

type Pt = { x: number; y: number };

/** "#rgb" / "#rrggbb" / "rgb(r, g, b)" -> [r, g, b]; null when unparseable. */
export function parseRgb(css: string): [number, number, number] | null {
	const s = css.trim();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
	if (hex) {
		let h = hex[1] as string;
		if (h.length === 3) h = h.split("").map((c) => c + c).join("");
		return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
	}
	const fn = /^rgba?\(\s*(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/i.exec(s);
	if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
	return null;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Clearing {
	pos: Map<string, Pt>;
	edges: [string, string][];
}

export class ForestCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: ForestCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	private hasFit = false;
	private destroyed = false;
	/** Last-synced CSS size (the resize anchor needs the PRE-resize size). */
	private viewW = 0;
	private viewH = 0;
	private kFit = 1;
	private minK = 0.01;
	private bbox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

	private model: ForestModel | null = null;
	private chains: readonly GraphChain[] = [];
	private colors: ForestColors = DEFAULT_FOREST_COLORS;
	private lightRgb: [number, number, number] = [232, 184, 90];
	private fontFamily = "sans-serif";
	private names: ReadonlyMap<string, string> = new Map();
	private states: ReadonlyMap<string, IdeaState> = new Map();
	private topicById = new Map<string, ForestTopic>();
	private clearings = new Map<string, Clearing>();

	private frameId: number | null = null;
	private dirty = true;
	private inTick = false;
	private animating = false;
	private lastTickAt = 0;
	private zoomTarget: { k: number; x: number; y: number } | null = null;
	private fly: { from: ForestCamera; to: Pt; toK: number; start: number } | null = null;

	private resizeObserver: ResizeObserver;
	private downPos: Pt | null = null;

	constructor(canvas: HTMLCanvasElement, callbacks: ForestCallbacks, initialCamera?: ForestCamera | null) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable");
		this.ctx = ctx;
		this.callbacks = callbacks;

		this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([this.minK, MAX_K])
			// Our own measured size (d3's default reads SVG attributes).
			.extent((): [[number, number], [number, number]] => [[0, 0], [this.viewW, this.viewH]])
			.on("zoom", ({ transform }: { transform: ZoomTransform }) => {
				this.transform = transform;
				this.markDirty();
				this.callbacks.onCameraMove({ k: transform.k, x: transform.x, y: transform.y });
			});
		select(canvas)
			.call(this.zoomBehavior)
			.on("dblclick.zoom", null)
			.on("wheel.zoom", null);

		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);

		if (
			initialCamera &&
			Number.isFinite(initialCamera.k) && initialCamera.k > 0 &&
			Number.isFinite(initialCamera.x) && Number.isFinite(initialCamera.y)
		) {
			this.hasFit = true;
			this.applyCamera(initialCamera.k, initialCamera.x, initialCamera.y);
		}

		this.resizeObserver = new ResizeObserver(() => {
			const prevW = this.viewW;
			const prevH = this.viewH;
			const { x: tx, y: ty, k } = this.transform;
			const wx = (prevW / 2 - tx) / k;
			const wy = (prevH / 2 - ty) / k;
			this.syncSize();
			if (!this.hasFit) this.fitWorld();
			else {
				this.refreshFit();
				// Keep the world point under the old centre under the new one.
				if (prevW > 0 && prevH > 0 && this.viewW > 0 && this.viewH > 0) {
					this.applyCamera(k, this.viewW / 2 - wx * k, this.viewH / 2 - wy * k);
				}
			}
			// Synchronous: resizing the backing store clears the canvas, and
			// rAF is starved during live resizes.
			this.draw();
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(
		model: ForestModel,
		chains: readonly GraphChain[],
		colors: ForestColors,
		fontFamily: string,
		ideas: ForestIdeaInfo = {},
	): void {
		this.model = model;
		this.chains = chains;
		this.colors = { ...DEFAULT_FOREST_COLORS, ...colors };
		this.lightRgb = parseRgb(this.colors.light) ?? [232, 184, 90];
		this.fontFamily = fontFamily || "sans-serif";
		this.names = ideas.names ?? new Map();
		this.states = ideas.states ?? new Map();
		this.topicById = new Map(model.topics.map((t) => [t.id, t]));
		this.clearings.clear();
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const t of model.topics) {
			if (t.x < minX) minX = t.x;
			if (t.y < minY) minY = t.y;
			if (t.x > maxX) maxX = t.x;
			if (t.y > maxY) maxY = t.y;
		}
		this.bbox = model.topics.length > 0 ? { minX, maxX, minY, maxY } : null;
		if (!this.hasFit) this.fitWorld();
		else this.refreshFit();
		this.markDirty();
	}

	/** Frame the whole forest (padding included). No-op until the canvas has a
	 *  real size (the ResizeObserver retries) or while there is nothing to frame. */
	fitWorld(): void {
		if (!this.bbox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return;
		const t = fitTransform(this.bbox, w, h, FIT_PADDING);
		const k = Math.min(t.k, FIT_K_CAP);
		this.kFit = t.k;
		this.updateExtent();
		this.hasFit = true;
		this.zoomTarget = null;
		this.fly = null;
		const cx = (this.bbox.minX + this.bbox.maxX) / 2;
		const cy = (this.bbox.minY + this.bbox.maxY) / 2;
		this.applyCamera(k, w / 2 - cx * k, h / 2 - cy * k);
	}

	/** Ease (~400 ms) to a clearing-sized zoom centred on the topic. */
	flyToTopic(id: string): void {
		const topic = this.topicById.get(id);
		if (!topic || this.viewW <= 0 || this.viewH <= 0) return;
		this.zoomTarget = null;
		const { k, x, y } = this.transform;
		this.fly = {
			from: { k, x, y },
			to: { x: topic.x, y: topic.y },
			toK: Math.min(Math.max(FLY_K, this.minK), MAX_K),
			start: performance.now(),
		};
		this.markDirty();
	}

	destroy(): void {
		this.destroyed = true;
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.frameId = null;
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.style.cursor = "";
	}

	// ── Camera ──

	/** Move the camera through d3-zoom so its state, persistence and the
	 *  card-dismiss all see the same change. */
	private applyCamera(k: number, x: number, y: number): void {
		select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(x, y).scale(k));
	}

	private updateExtent(): void {
		this.minK = Math.min(Math.max(0.5 * this.kFit, 1e-4), MAX_K);
		this.zoomBehavior.scaleExtent([this.minK, MAX_K]);
	}

	private refreshFit(): void {
		if (!this.bbox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return;
		this.kFit = fitTransform(this.bbox, w, h, FIT_PADDING).k;
		this.updateExtent();
	}

	// ── Events (state mutation only — never draw) ──

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		this.fly = null;
		const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
		const { x, y } = this.eventPos(e);
		const current = this.zoomTarget?.k ?? this.transform.k;
		const k = Math.min(Math.max(current * Math.exp(delta), this.minK), MAX_K);
		this.zoomTarget = { k, x, y };
		this.lastTickAt = performance.now();
		this.markDirty();
	};

	private onPointerMove = (e: PointerEvent) => {
		if (this.downPos) return; // panning
		const pos = this.eventPos(e);
		const hit = this.pickIdeaAt(pos.x, pos.y) || this.pickTopicAt(pos.x, pos.y);
		this.canvas.style.cursor = hit ? "pointer" : "";
	};

	private onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return;
		this.downPos = this.eventPos(e);
		this.zoomTarget = null; // a pan takes over
		this.fly = null;
	};

	private onPointerUp = (e: PointerEvent) => {
		if (e.button !== 0 || !this.downPos) return;
		const pos = this.eventPos(e);
		const moved = Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y);
		this.downPos = null;
		if (moved > CLICK_SLOP) return; // a pan, not a click
		if (forestLevel(this.transform.k) === "clearing") {
			const idea = this.pickIdeaAt(pos.x, pos.y);
			if (idea) {
				this.callbacks.onIdeaClick(idea, pos);
				return;
			}
		}
		const topic = this.pickTopicAt(pos.x, pos.y);
		if (topic) this.callbacks.onTopicClick(topic);
		else this.callbacks.onStageClick();
	};

	private onPointerLeave = () => {
		this.downPos = null;
	};

	private eventPos(e: { clientX: number; clientY: number }): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	// ── Picking ──

	private pickTopicAt(px: number, py: number): string | null {
		if (!this.model) return null;
		const { x: tx, y: ty, k } = this.transform;
		const maxDist = CLEARING_R * k + 10;
		const vis = visibleTopics(this.model.topics, this.transform, this.viewW, this.viewH, maxDist);
		const hit = pickNearest(
			vis.map((t) => ({ id: t.id, x: t.x * k + tx, y: t.y * k + ty })),
			px,
			py,
			maxDist,
		);
		return hit?.id ?? null;
	}

	private pickIdeaAt(px: number, py: number): string | null {
		if (!this.model || forestLevel(this.transform.k) !== "clearing") return null;
		const { x: tx, y: ty, k } = this.transform;
		const pad = 2 * CLEARING_R * k + 40;
		const projected: { id: string; x: number; y: number }[] = [];
		for (const t of visibleTopics(this.model.topics, this.transform, this.viewW, this.viewH, pad)) {
			if (t.glow <= 0) continue;
			for (const [id, p] of this.clearingOf(t).pos) projected.push({ id, x: p.x * k + tx, y: p.y * k + ty });
		}
		return pickNearest(projected, px, py, IDEA_R_PX + 6)?.id ?? null;
	}

	// ── Loop ──

	private markDirty(): void {
		this.dirty = true;
		if (this.destroyed) return;
		if (this.frameId === null && !this.inTick) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		if (this.destroyed) return;
		this.inTick = true;
		try {
			const now = performance.now();
			const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
			this.lastTickAt = now;
			const flying = this.advanceFly(now);
			const gliding = this.advanceZoom(dt);
			this.draw();
			this.animating = flying || gliding;
		} finally {
			this.inTick = false;
		}
		if (this.animating) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	/** Wheel glide: ease k toward the target, keeping the cursor's world
	 *  point pinned. Returns true while still gliding. */
	private advanceZoom(dt: number): boolean {
		const target = this.zoomTarget;
		if (!target) return false;
		const t = this.transform;
		const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
		let k = t.k + (target.k - t.k) * blend;
		let done = false;
		if (Math.abs(target.k - k) / target.k < 0.002) {
			k = target.k;
			done = true;
		}
		const scale = k / t.k;
		if (done) this.zoomTarget = null;
		this.applyCamera(k, target.x - (target.x - t.x) * scale, target.y - (target.y - t.y) * scale);
		return !done;
	}

	/** Fly step: log-interpolate k and the world point at the viewport
	 *  centre, so the move reads as one smooth swoop. */
	private advanceFly(now: number): boolean {
		const f = this.fly;
		if (!f) return false;
		const t = Math.min((now - f.start) / FLY_MS, 1);
		const e = ease(t);
		const k = Math.exp(Math.log(f.from.k) + (Math.log(f.toK) - Math.log(f.from.k)) * e);
		const fromCx = (this.viewW / 2 - f.from.x) / f.from.k;
		const fromCy = (this.viewH / 2 - f.from.y) / f.from.k;
		const cx = fromCx + (f.to.x - fromCx) * e;
		const cy = fromCy + (f.to.y - fromCy) * e;
		if (t >= 1) this.fly = null;
		this.applyCamera(k, this.viewW / 2 - cx * k, this.viewH / 2 - cy * k);
		return t < 1;
	}

	private syncSize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const bw = Math.max(1, Math.round(w * dpr));
		const bh = Math.max(1, Math.round(h * dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = w;
		this.viewH = h;
	}

	// ── Clearings ──

	private clearingOf(topic: ForestTopic): Clearing {
		const key = topic.id + "\u0000" + topic.ideas.join(",");
		const cached = this.clearings.get(key);
		if (cached) return cached;
		const pos = layoutClearing(topic.ideas, this.chains, topic, CLEARING_R);
		const edges: [string, string][] = [];
		for (const c of this.chains) {
			if (!pos.has(c.conclusion)) continue;
			for (const p of c.premises) if (p !== c.conclusion && pos.has(p)) edges.push([p, c.conclusion]);
		}
		const made = { pos, edges };
		this.clearings.set(key, made);
		return made;
	}

	// ── Drawing ──

	private rgba(a: number): string {
		const [r, g, b] = this.lightRgb;
		return `rgba(${r}, ${g}, ${b}, ${a})`;
	}

	private draw(): void {
		this.dirty = false;
		const ctx = this.ctx;
		const w = this.viewW;
		const h = this.viewH;
		const dpr = window.devicePixelRatio || 1;
		const c = this.colors;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = 1;
		ctx.fillStyle = c.bg;
		ctx.fillRect(0, 0, Math.max(w, 1), Math.max(h, 1));
		const model = this.model;
		if (!model || model.topics.length === 0 || w <= 0 || h <= 0) return;

		const cam = this.transform;
		const { k, x: tx, y: ty } = cam;
		const level = forestLevel(k);
		const visible = visibleTopics(model.topics, cam, w, h, 2 * CLEARING_R * k + 40);
		const lit = visible.filter((t) => t.glow > 0);

		// World space: line widths and radii divide by k.
		ctx.save();
		ctx.translate(tx, ty);
		ctx.scale(k, k);

		// 2. Trees: every visible fogged topic, one batched path.
		const dots = TREE_R * k < MIN_TREE_PX;
		const trees = new Path2D();
		for (const t of visible) {
			if (t.glow > 0) continue;
			if (dots) {
				const half = MIN_TREE_PX / 2 / k;
				trees.rect(t.x - half, t.y - half, MIN_TREE_PX / k, MIN_TREE_PX / k);
			} else {
				trees.moveTo(t.x + TREE_R, t.y);
				trees.arc(t.x, t.y, TREE_R, 0, Math.PI * 2);
			}
		}
		if (dots) {
			ctx.fillStyle = c.treeEdge;
			ctx.fill(trees);
		} else {
			ctx.fillStyle = c.tree;
			ctx.fill(trees);
			ctx.strokeStyle = c.treeEdge;
			ctx.lineWidth = 1 / k;
			ctx.stroke(trees);
		}

		// 3. Light: a radial glow per lit topic.
		for (const t of lit) {
			const r = CLEARING_R * (1.4 + t.glow);
			if (r * k < 2) continue; // the speck below carries it
			const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, r);
			g.addColorStop(0, this.rgba(t.glow));
			g.addColorStop(1, this.rgba(0));
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
			ctx.fill();
		}

		// 4. Trails, from region level up: dotted, cross-degree 1.5x wider.
		if (level !== "world" && model.trails.length > 0) {
			ctx.strokeStyle = c.trail;
			ctx.globalAlpha = 0.75;
			ctx.setLineDash([4 / k, 6 / k]);
			for (const cross of [false, true]) {
				ctx.lineWidth = (cross ? 1.5 : 1) * 1.5 / k;
				ctx.beginPath();
				for (const tr of model.trails) {
					if (tr.crossDegree !== cross) continue;
					const a = this.topicById.get(tr.a);
					const b = this.topicById.get(tr.b);
					if (!a || !b) continue;
					const ax = a.x * k + tx;
					const ay = a.y * k + ty;
					const bx = b.x * k + tx;
					const by = b.y * k + ty;
					if ((ax < 0 && bx < 0) || (ax > w && bx > w) || (ay < 0 && by < 0) || (ay > h && by > h)) continue;
					ctx.moveTo(a.x, a.y);
					ctx.lineTo(b.x, b.y);
				}
				ctx.stroke();
			}
			ctx.setLineDash([]);
			ctx.globalAlpha = 1;
		}
		ctx.restore();

		// Screen space from here: text and fixed-size marks.
		ctx.textAlign = "center";

		// Lit topics' specks at world level, so a single idea shows at full fit.
		if (level === "world") {
			ctx.fillStyle = c.light;
			for (const t of lit) {
				ctx.globalAlpha = 0.5 + 0.5 * t.glow;
				ctx.fillRect(t.x * k + tx - 1, t.y * k + ty - 1, 2, 2);
			}
			ctx.globalAlpha = 1;
		}

		// 5. Degree names: faint italics, fading out by REGION_K * 2.
		const nameAlpha = k < REGION_K ? WORLD_NAME_ALPHA : WORLD_NAME_ALPHA * Math.max(0, 1 - (k - REGION_K) / REGION_K);
		if (nameAlpha > 0 && model.regions.length > 0) {
			ctx.font = `italic ${NAME_PX}px ${this.fontFamily}`;
			ctx.fillStyle = c.label;
			ctx.textBaseline = "middle";
			ctx.globalAlpha = nameAlpha;
			for (const r of model.regions) {
				const sx = r.x * k + tx;
				const sy = r.y * k + ty;
				if (sx < -200 || sx > w + 200 || sy < -40 || sy > h + 40) continue;
				ctx.fillText(r.name, sx, sy);
			}
			ctx.globalAlpha = 1;
		}

		// 6. Topic labels, from region level up, capped per frame.
		if (level !== "world") {
			ctx.font = `${LABEL_PX}px ${this.fontFamily}`;
			ctx.textBaseline = "top";
			const below = TREE_R * k + 3;
			for (const t of pickLabels(visible, LABEL_BUDGET)) {
				const sx = t.x * k + tx;
				const sy = t.y * k + ty;
				if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100) continue;
				ctx.fillStyle = t.glow > 0 ? c.label : c.fogLabel;
				ctx.fillText(t.glow > 0 ? t.name : `${t.name} ?`, sx, sy + below);
			}
		}

		// 7. Clearings: each visible lit topic's ideas and the chains between them.
		if (level === "clearing") {
			for (const t of lit) this.drawClearing(t, k, tx, ty);
		}
	}

	private drawClearing(topic: ForestTopic, k: number, tx: number, ty: number): void {
		const ctx = this.ctx;
		const c = this.colors;
		const { pos, edges } = this.clearingOf(topic);
		if (pos.size === 0) return;
		if (edges.length > 0) {
			ctx.strokeStyle = c.label;
			ctx.globalAlpha = 0.35;
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (const [a, b] of edges) {
				const pa = pos.get(a) as Pt;
				const pb = pos.get(b) as Pt;
				ctx.moveTo(pa.x * k + tx, pa.y * k + ty);
				ctx.lineTo(pb.x * k + tx, pb.y * k + ty);
			}
			ctx.stroke();
			ctx.globalAlpha = 1;
		}
		ctx.font = `${IDEA_LABEL_PX}px ${this.fontFamily}`;
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		for (const [id, p] of pos) {
			const sx = p.x * k + tx;
			const sy = p.y * k + ty;
			const state = this.states.get(id) ?? "seen";
			ctx.globalAlpha = state === "seen" ? 0.6 : 1;
			ctx.fillStyle = state === "held" ? HELD_COLOR : state === "fast" ? c.light : c.label;
			ctx.beginPath();
			ctx.arc(sx, sy, IDEA_R_PX / 2, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;
			const name = this.names.get(id);
			if (name) {
				ctx.fillStyle = c.label;
				ctx.fillText(name, sx + IDEA_R_PX / 2 + 4, sy);
			}
		}
		ctx.textAlign = "center";
	}
}
