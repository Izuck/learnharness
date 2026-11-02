import { forestView } from "@/src/server";

/**
 * The forest home view's data endpoint — thin transport: the server entry
 * (src/server/forest.ts) returns the fog-of-war forest model plus the graph
 * slice the page opens ideas from.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(forestView());
}
