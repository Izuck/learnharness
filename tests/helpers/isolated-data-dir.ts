/**
 * Side-effect module: point the data-location seam (config.ts LH_DATA_DIR) at a
 * fresh temp dir. Import it FIRST in a test file — static imports evaluate in
 * order, and config.ts reads the env var once at load, so every app module
 * imported after this one lands in the temp dir instead of the shared repo
 * data/. The importing test removes `ISOLATED_DATA_DIR` in its after() hook.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ISOLATED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-jobs-test-"));
process.env.LH_DATA_DIR = ISOLATED_DATA_DIR;
