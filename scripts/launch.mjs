// The Forest program. Started by the Start menu / desktop shortcut (through launch-hidden.vbs, so no
// console shows) or by `npm run app`. It starts `next dev` (what `npm run dev` runs) on localhost only,
// opens it in its own window, and stops the server when the window closes.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = process.env.PORT || "3000";
const APP_URL = `http://localhost:${PORT}`;
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
// Every mutable record (chats, graph) lives here, outside the repo, so it survives re-clones and tests never touch it.
const DATA = process.env.LH_DATA_DIR || path.join(os.homedir(), "Documents", "learnharness-data");
const PROFILE = path.join(DATA, ".app-window"); // the window's own browser profile, separate from yours

fs.mkdirSync(DATA, { recursive: true });
const logFile = fs.openSync(path.join(DATA, "app.log"), "a");
const log = (s) => fs.writeSync(logFile, `[${new Date().toISOString()}] ${s}\n`);

async function up() {
	try {
		const r = await fetch(APP_URL, { signal: AbortSignal.timeout(60_000) });
		return r.status < 500;
	} catch {
		return false;
	}
}

function findBrowser() {
	const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
	const pf = process.env.ProgramFiles || "C:/Program Files";
	const local = process.env.LOCALAPPDATA || "";
	const candidates = [
		path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
		path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
		path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
		path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
		path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
		path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
	];
	return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Open a page as an app window (no tabs or address bar). Returns the browser process. */
function openWindow(browser, url) {
	if (!browser) {
		spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		return null;
	}
	return spawn(browser, [`--app=${url}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"], { stdio: "ignore" });
}

const browser = findBrowser();

// Already running: just open another window onto it.
if (await up()) {
	log("app already running; opening a window");
	openWindow(browser, APP_URL)?.unref();
	process.exit(0);
}

log(`starting (browser: ${browser ?? "default"}, data: ${DATA})`);
// Run next's own entry point with node: `npm` is a .cmd on Windows, and killing it would leave the server running.
const server = spawn(process.execPath, [NEXT, "dev", "-p", PORT, "-H", "localhost"], {
	cwd: ROOT,
	stdio: ["ignore", logFile, logFile],
	env: { ...process.env, LH_DATA_DIR: DATA, NODE_ENV: "development" },
	windowsHide: true,
});
server.on("exit", (code) => {
	log(`server exited (${code})`);
	process.exit(code ?? 0);
});

function shutdown(why) {
	log(`stopping: ${why}`);
	// next dev starts worker processes; /T takes the whole tree down.
	if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { windowsHide: true });
	else server.kill();
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("interrupted"));
process.on("SIGTERM", () => shutdown("terminated"));

let ready = false;
for (let i = 0; i < 240 && !ready; i++) {
	ready = await up();
	if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
	log("server did not start");
	shutdown("server did not start");
} else {
	log(`ready at ${APP_URL}`);
	const win = openWindow(browser, APP_URL);
	// Stop when the window closes (its profile is its own, so the process lives exactly as long as the window).
	win?.on("exit", () => shutdown("window closed"));
}
