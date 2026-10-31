/**
 * The visible text of an assistant message: its text blocks, joined with a
 * blank line. A message can hold several adjacent text blocks (text on both
 * sides of a tool call the provider never recorded, or a provider that splits
 * a reply), and a plain "" join runs the last word of one into the first of
 * the next. Empty (or whitespace-only) blocks are skipped so they never
 * leave a stray gap.
 */
export function joinTextBlocks(content: readonly { type: string; text?: string }[]): string {
	return content
		.flatMap((block) => (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "" ? [block.text] : []))
		.join("\n\n");
}
