// The Forest's one default data folder, shared by the launcher (scripts/launch.mjs) and the world
// scripts (through scripts/default-data-dir.mjs). Pure: importing this module changes nothing.
import os from "node:os";
import path from "node:path";

/** Where every mutable record lives when LH_DATA_DIR is unset: outside the repo, so it survives
 *  re-clones and tests (which resolve to the repo's data/) never touch it.
 *  @param {string} [homeDir]
 *  @returns {string} */
export function defaultDataDir(homeDir = os.homedir()) {
	return path.join(homeDir, "Documents", "learnharness-data");
}
