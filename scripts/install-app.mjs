// npm run install-app: add "Forest" to the Start menu and the desktop.
// npm run install-app -- --remove: remove both shortcuts (your data folder is untouched).
// The shortcuts run scripts/launch-hidden.vbs with Windows Script Host, so no console window shows.
import { spawnSync } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") {
	console.log("Shortcuts are Windows-only. Elsewhere, run: npm run app");
	process.exit(0);
}

const ROOT = path.resolve(import.meta.dirname, "..");
const remove = process.argv.includes("--remove");
const esc = (s) => s.replace(/'/g, "''"); // PowerShell single-quoted string

const ps = `
$ErrorActionPreference = 'Stop'
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $places) {
	$lnk = Join-Path $dir 'Forest.lnk'
	if (${remove ? "$true" : "$false"}) {
		if (Test-Path $lnk) { Remove-Item $lnk; Write-Output "removed  $lnk" }
		continue
	}
	$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
	$sh.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
	$sh.Arguments = '"${esc(path.join(ROOT, "scripts", "launch-hidden.vbs"))}"'
	$sh.WorkingDirectory = '${esc(ROOT)}'
	$sh.IconLocation = '${esc(path.join(ROOT, "build", "icon.ico"))},0'
	$sh.Description = 'Forest: learn with an AI teacher and a map of what you know'
	$sh.Save()
	Write-Output "created  $lnk"
}
`;

const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) {
	process.stderr.write(r.stderr);
	process.exit(r.status ?? 1);
}
if (!remove) console.log('\nDone. Open "Forest" from the Start menu or the desktop. Pin it to the taskbar from the Start menu if you like.');
