"use client";

/**
 * The forest's idea card: one idea's statement, the chains it takes part in
 * (premises ⟹ conclusion, by name) and the sessions it came up in — the same
 * content as the graph view's inline node card. Pure props in, markup out.
 */

import Link from "next/link";
import { FileTextIcon } from "lucide-react";
import { propositionSessionHref, type GraphChain, type GraphNode } from "@/src/core";

export function ForestIdeaCard({
	node,
	nodes = [],
	chains,
	sessions,
	fileSources,
	nodeSessions,
	className,
	style,
}: {
	node: GraphNode;
	/** Every proposition, to resolve chain members' names (an id with no match
	 *  is shown as the raw id — honest, never guessed). */
	nodes?: readonly Pick<GraphNode, "id" | "name">[];
	chains: readonly GraphChain[];
	/** chatId -> title. */
	sessions: Readonly<Record<string, string>>;
	/** Imported-notes source id -> file path. */
	fileSources: Readonly<Record<string, string>>;
	/** nodeId -> the chats / sources it came up in. */
	nodeSessions: Readonly<Record<string, string[]>>;
	className?: string;
	style?: React.CSSProperties;
}) {
	const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
	nameOf.set(node.id, node.name);
	const name = (id: string) => nameOf.get(id) ?? id;
	const involved = chains
		.filter((c) => c.conclusion === node.id || c.premises.includes(node.id))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const sourceIds = nodeSessions[node.id] ?? [];

	return (
		<div
			data-testid="forest-idea-card"
			style={style}
			className={`lh-no-drag w-80 max-w-[calc(100%-1rem)] max-h-[70vh] overflow-y-auto rounded-xl border bg-card p-4 text-left shadow-lg ${className ?? ""}`}
		>
			<div className="text-sm font-medium leading-snug">{node.name}</div>
			<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{node.statement}</div>
			{involved.length > 0 && (
				<div className="mt-3 flex flex-col gap-1">
					<div className="text-xs text-muted-foreground">Chains</div>
					{involved.map((chain) => (
						<div key={chain.id} className="text-xs leading-relaxed text-foreground">
							{`${[...chain.premises].sort().map(name).join(", ")} ⟹ ${name(chain.conclusion)}`}
						</div>
					))}
				</div>
			)}
			{sourceIds.length > 0 && (
				<div className="mt-3 flex flex-col gap-1">
					<div className="text-xs text-muted-foreground">Sessions</div>
					{sourceIds.map((sourceId) => {
						const file = fileSources[sourceId];
						if (file !== undefined) {
							// An imported-notes file: static text, there is no session to open.
							return (
								<div key={sourceId} className="flex items-center gap-1.5">
									<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">{file}</span>
								</div>
							);
						}
						return (
							<div key={sourceId} className="flex items-center gap-1.5">
								<Link
									href={propositionSessionHref(node, sourceId)}
									scroll={false}
									className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
								>
									{sessions[sourceId] ?? sourceId}
								</Link>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
