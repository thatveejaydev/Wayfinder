import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const args = process.argv.slice(2);
const dev = args[0] === "dev";
const child = spawn(process.execPath, [cli, ...args], {
  stdio: "inherit",
  env: dev
    ? { ...process.env, RADIAL_DEV_SUPERVISOR_PID: String(process.pid) }
    : process.env,
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("exit", () => process.exit(130));
    killer.once("error", () => process.exit(130));
  } else {
    child.kill("SIGINT");
    process.exit(130);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
});
