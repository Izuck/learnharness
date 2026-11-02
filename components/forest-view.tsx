"use client";

/**
 * The forest home: the fixed world seen through the learner's graph. Lit
 * topics are the ones holding ideas, everything else stays fogged. This
 * component owns data (GET /api/forest), the overlays and the idea card; the
 * canvas itself is ForestCanvasRenderer.
 *
 * Refetch triggers: the activity channel (extraction finished), the sidebar's
 * lh:graph-revision announcement (a deletion), and window focus — the placer
 * writes placements in the background after extraction, so focus catches those.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatCoverage, forestLevel, type ForestCamera, type ForestSnapshot, type GraphNode } from "@/src/core";
import { useServerEvent } from "@/components/server-events";
import { ForestCanvasRenderer, DEFAULT_FOREST_COLORS, type ForestCallbacks, type ForestColors } from "./forest-canvas.ts";
import { ForestIdeaCard } from "./forest-idea-card.tsx";

const CAMERA_STORAGE_PREFIX = "lh.forest.camera.v2";
/** The camera is stored per world: a different world (a new layout, a
 *  regeneration) must not open on the previous one's view. */
const cameraStorageKey = (worldKey: string): string => `${CAMERA_STORAGE_PREFIX}:${worldKey}`;
const CARD_W = 320;
const CARD_EST_H = 260;

/** The persisted camera, or null when absent or malformed. */
function readStoredCamera(worldKey: string): ForestCamera | null {
	try {
		const stored = localStorage.getItem(cameraStorageKey(worldKey));
		if (!stored) return null;
		const p = JSON.parse(stored) as { k?: unknown; x?: unknown; y?: unknown };
		if (
			typeof p.k === "number" && Number.isFinite(p.k) && p.k > 0 &&
			typeof p.x === "number" && Number.isFinite(p.x) &&
			typeof p.y === "number" && Number.isFinite(p.y)
		)
			return { k: p.k, x: p.x, y: p.y };
	} catch {
		// Corrupt or blocked storage: treat as absent.
	}
	return null;
}

/** The forest tokens as CSS colour strings; a missing token keeps its default. */
function readColors(): { colors: ForestColors; fontFamily: string } {
	const colors = { ...DEFAULT_FOREST_COLORS };
	let fontFamily = "sans-serif";
	try {
		const css = getComputedStyle(document.documentElement);
		const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
		colors.bg = token("--lh-forest-bg", colors.bg);
		colors.tree = token("--lh-forest-tree", colors.tree);
		colors.treeEdge = token("--lh-forest-tree-edge", colors.treeEdge);
		colors.light = token("--lh-forest-light", colors.light);
		colors.trail = token("--lh-forest-trail", colors.trail);
		colors.label = token("--lh-forest-label", colors.label);
		colors.fogLabel = token("--lh-forest-fog-label", colors.fogLabel);
		fontFamily = css.fontFamily || fontFamily;
	} catch {
		// Defaults stand.
	}
	return { colors, fontFamily };
}

interface Selected {
	node: GraphNode;
	/** Click point in stage pixels; null = pinned top-right (uncharted list). */
	anchor: { x: number; y: number } | null;
}

function Step({ children }: { children: string }) {
	return <code className="block rounded-md bg-muted px-3 py-1.5 font-mono text-sm text-foreground">{children}</code>;
}

function Notice({ children }: { children: React.ReactNode }) {
	return (
		<div className="absolute inset-0 flex items-center justify-center p-6">
			<div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">{children}</div>
		</div>
	);
}

function EmptyState({ needsGenerate }: { needsGenerate: boolean }) {
	return (
		<div className="absolute inset-0 flex items-center justify-center p-6">
			<div className="flex max-w-md flex-col gap-3 text-sm text-muted-foreground">
				{needsGenerate ? (
					<>
						<div className="text-base font-medium text-foreground">The forest has no world yet</div>
						<div>Build the world, merge its duplicate topics, then lay it out:</div>
						<Step>npm run world:generate</Step>
						<Step>npm run world:dedupe</Step>
						<Step>npm run world:layout</Step>
					</>
				) : (
					<>
						<div className="text-base font-medium text-foreground">The world has no positions yet</div>
						<div>Merge duplicate topics first if you haven&apos;t yet (layout locks positions in):</div>
						<Step>npm run world:dedupe</Step>
						<div>Then lay it out to grow the forest:</div>
						<Step>npm run world:layout</Step>
					</>
				)}
				<Link href="/graph" className="text-foreground underline underline-offset-4">
					Open the graph instead
				</Link>
			</div>
		</div>
	);
}

export function ForestView() {
	const [snapshot, setSnapshot] = useState<ForestSnapshot | null>(null);
	const [unchartedOpen, setUnchartedOpen] = useState(false);
	const [selected, setSelected] = useState<Selected | null>(null);
	/** The last fetch failed (the previous snapshot, if any, stays on screen). */
	const [failed, setFailed] = useState(false);
	/** The 2D context was unavailable when the renderer was built. */
	const [canvasBroken, setCanvasBroken] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<ForestCanvasRenderer | null>(null);
	const snapshotRef = useRef<ForestSnapshot | null>(null);
	const cameraRef = useRef<ForestCamera | null>(null);
	/** True until the first fit of a fresh renderer with no stored camera: the
	 *  user's camera must survive every later reload. */
	const needsFitRef = useRef(false);
	snapshotRef.current = snapshot;

	// ── Data ──
	const requestRef = useRef(0);
	const refresh = useCallback(() => {
		const mine = ++requestRef.current;
		fetch("/api/forest")
			.then((res) => {
				if (!res.ok) throw new Error(`forest ${res.status}`);
				return res.json() as Promise<ForestSnapshot>;
			})
			.then((next) => {
				if (mine !== requestRef.current) return; // a newer request supersedes
				setSnapshot(next);
				setFailed(false);
			})
			.catch((err) => {
				console.error("[forest] fetch failed", err);
				if (mine === requestRef.current) setFailed(true);
			});
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useServerEvent("activity-changed", () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			refresh();
		}, 250);
	});
	useEffect(() => {
		window.addEventListener("lh:graph-revision", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			window.removeEventListener("lh:graph-revision", refresh);
			window.removeEventListener("focus", refresh);
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh]);

	const model = snapshot?.model ?? null;
	const hasForest = model !== null && model.topics.length > 0;
	const worldKey = model?.worldKey ?? "";
	const names = useMemo(
		() => new Map((snapshot?.graph.propositions ?? []).map((n) => [n.id, n.name])),
		[snapshot],
	);

	// ── Renderer: built when the canvas appears, destroyed when it goes ──
	useEffect(() => {
		if (!hasForest) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const storageKey = cameraStorageKey(worldKey);
		const initial = readStoredCamera(worldKey);
		needsFitRef.current = initial === null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let last: ForestCamera | null = null;
		const write = (cam: ForestCamera) => {
			try {
				localStorage.setItem(storageKey, JSON.stringify(cam));
			} catch {
				// Camera persistence is best-effort.
			}
		};
		const callbacks: ForestCallbacks = {
			onTopicClick: (id) => {
				// Fly in from the world and region levels; inside a clearing a
				// click on the ground only dismisses the card.
				if (forestLevel(cameraRef.current?.k ?? 0) !== "clearing") rendererRef.current?.flyToTopic(id);
				else setSelected(null);
			},
			onIdeaClick: (nodeId, screen) => {
				const node = snapshotRef.current?.graph.propositions.find((n) => n.id === nodeId);
				if (node) setSelected({ node, anchor: screen });
			},
			onStageClick: () => setSelected(null),
			onCameraMove: (cam) => {
				cameraRef.current = cam;
				setSelected(null); // a moving camera detaches the card from its idea
				last = cam;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = null;
					write(cam);
				}, 250);
			},
		};
		let renderer: ForestCanvasRenderer;
		try {
			renderer = new ForestCanvasRenderer(canvas, callbacks, initial);
		} catch (err) {
			console.error("[forest] renderer unavailable", err);
			setCanvasBroken(true);
			return;
		}
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			if (timer && last) {
				clearTimeout(timer);
				write(last);
			}
			renderer.destroy();
		};
	}, [hasForest, worldKey]);

	// Feed the renderer after every load. Colours are read once per load.
	useEffect(() => {
		const renderer = rendererRef.current;
		if (!renderer || !snapshot?.model || snapshot.model.topics.length === 0) return;
		const { colors, fontFamily } = readColors();
		renderer.setData(snapshot.model, snapshot.graph.chains, colors, fontFamily, { names });
		if (needsFitRef.current) {
			needsFitRef.current = false;
			renderer.fitWorld(); // at 0x0 this no-ops and the renderer's ResizeObserver fits instead
		}
	}, [snapshot, hasForest, names]);

	// A reload can drop the selected idea.
	useEffect(() => {
		setSelected((sel) => (sel && snapshot?.graph.propositions.some((n) => n.id === sel.node.id) ? sel : null));
	}, [snapshot]);

	// Escape closes the card.
	useEffect(() => {
		if (!selected) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setSelected(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selected]);

	// "f" frames the whole forest — unless the user is typing somewhere.
	useEffect(() => {
		if (!hasForest) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "f" && e.key !== "F") return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			const active = document.activeElement as HTMLElement | null;
			const typing = (el: HTMLElement | null) =>
				!!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
			if (typing(target) || typing(active)) return;
			rendererRef.current?.fitWorld();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hasForest]);

	// ── Render ──
	const unplaced = model?.unplaced ?? 0;
	const unpositioned = model?.unpositioned ?? 0;
	const uncharted = model?.uncharted ?? [];

	const cardStyle = (() => {
		if (!selected?.anchor) return undefined;
		const el = containerRef.current;
		const W = el?.clientWidth || 0;
		const H = el?.clientHeight || 0;
		const left = W > 0 ? Math.min(Math.max(selected.anchor.x - CARD_W / 2, 8), Math.max(8, W - CARD_W - 8)) : selected.anchor.x;
		const flip = H > 0 && selected.anchor.y + CARD_EST_H + 16 > H;
		return flip
			? { left, top: selected.anchor.y - 12, transform: "translateY(-100%)" }
			: { left, top: selected.anchor.y + 12 };
	})();

	return (
		<div
			ref={containerRef}
			className="relative h-full w-full overflow-hidden"
			style={{ background: "var(--lh-forest-bg)" }}
		>
			{hasForest && !canvasBroken && <canvas ref={canvasRef} className="absolute inset-0 size-full touch-none" />}
			{hasForest && canvasBroken && <Notice>Canvas unavailable</Notice>}
			{snapshot && !hasForest && <EmptyState needsGenerate={!model || model.unpositioned === 0} />}
			{!snapshot && !failed && <Notice>Loading…</Notice>}
			{!snapshot && failed && (
				<Notice>
					<div className="text-base font-medium text-foreground">Couldn&apos;t load the forest</div>
					<button
						type="button"
						onClick={() => {
							setFailed(false);
							refresh();
						}}
						className="rounded-full border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
					>
						Retry
					</button>
				</Notice>
			)}

			{/* One top-left column BELOW the floating header row (h-13 = 52px): the
			    coverage lines (and the stale-data note), Fit world, then the
			    uncharted control (its list drops down). The pinned idea card owns
			    the top-right. */}
			{((hasForest && model) || (snapshot && failed)) && (
				<div className="pointer-events-none absolute left-3 top-14 z-10 flex max-w-xs flex-col items-start gap-1.5">
					<div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
						{hasForest && model && (
							<div>{`Mapped ${formatCoverage(model.coverage.mapped, model.coverage.total)} of undergrad STEM`}</div>
						)}
						{hasForest && unplaced > 0 && <div>{`${unplaced} ${unplaced === 1 ? "idea" : "ideas"} waiting to be placed`}</div>}
						{hasForest && unpositioned > 0 && (
							<div>{`${unpositioned} ${unpositioned === 1 ? "topic" : "topics"} not laid out yet — npm run world:layout`}</div>
						)}
						{snapshot && failed && <div>Couldn&apos;t refresh</div>}
					</div>
					{hasForest && !canvasBroken && (
						<button
							type="button"
							onClick={() => rendererRef.current?.fitWorld()}
							className="lh-no-drag pointer-events-auto rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
						>
							Fit world
						</button>
					)}
					{uncharted.length > 0 && (
						<div className="lh-no-drag pointer-events-auto flex w-full flex-col items-start gap-1">
							<button
								type="button"
								aria-expanded={unchartedOpen}
								onClick={() => setUnchartedOpen((o) => !o)}
								className="rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
							>
								{`Uncharted (${uncharted.length})`}
							</button>
							{unchartedOpen && (
								<div className="flex max-h-60 w-full flex-col overflow-y-auto rounded-xl border bg-card p-1 shadow-lg">
									{uncharted.map((id) => {
										const node = snapshot?.graph.propositions.find((n) => n.id === id);
										return (
											<button
												key={id}
												type="button"
												disabled={!node}
												onClick={() => node && setSelected({ node, anchor: null })}
												className="truncate rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
											>
												{node?.name ?? id}
											</button>
										);
									})}
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{selected && snapshot && (
				<ForestIdeaCard
					node={selected.node}
					nodes={snapshot.graph.propositions}
					chains={snapshot.graph.chains}
					sessions={snapshot.graph.sessions}
					fileSources={snapshot.graph.fileSources}
					nodeSessions={snapshot.graph.nodeSessions}
					className={selected.anchor ? "absolute z-20" : "absolute right-3 top-14 z-20"}
					style={cardStyle}
				/>
			)}
		</div>
	);
}
