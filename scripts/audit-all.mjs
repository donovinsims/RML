#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.AUDIT_PORT || 4324);
const cloneUrl = `http://127.0.0.1:${port}/`;

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(cloneUrl);
      if (response.ok) return;
    } catch {
      // Keep polling while the local server starts.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Static server did not start at ${cloneUrl}`);
}

const server = spawn(process.execPath, ["serve.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

let auditExit = 1;
let geometryExit = 1;
let claimsExit = 1;
try {
  await waitForServer();
  auditExit = await run("scripts/audit-responsive.mjs", [
    "--source", "capture",
    "--clone-url", cloneUrl,
    "--out", ".audit/responsive",
  ]);
  geometryExit = await run("scripts/compare-pipe-geometry.mjs", [
    "--source", "https://revenuemedialab.com/",
    "--clone", cloneUrl,
    "--out", ".audit/pipe-geometry",
  ]);
  claimsExit = await run("scripts/verify-claims.mjs", []);
} finally {
  server.kill("SIGTERM");
}

console.log(JSON.stringify({ auditExit, geometryExit, claimsExit, cloneUrl }, null, 2));
process.exitCode = auditExit || geometryExit || claimsExit ? 1 : 0;
