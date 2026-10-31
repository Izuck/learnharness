// Preloaded by the world scripts (`tsx --import ./scripts/default-data-dir.mjs ...`, package.json) and
// imported by the launcher: when LH_DATA_DIR is unset (or empty) it points it at the app's data folder,
// BEFORE config.ts is imported (config reads the env once, at import time). So `npm run world:generate`
// writes where the app reads. `npm test` never loads this, and keeps resolving to the repo's data/.
import { defaultDataDir } from "./data-dir.mjs";

if (!process.env.LH_DATA_DIR) process.env.LH_DATA_DIR = defaultDataDir();
