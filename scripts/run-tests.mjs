#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testFiles = (await readdir(join(root, "tests")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("tests", name));

if (testFiles.length === 0) {
  console.error("No tests/*.test.mjs files found.");
  process.exit(1);
}

const logPath = join(root, ".audit/alignment/test.log");
await mkdir(dirname(logPath), { recursive: true });

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

let output = "";
for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (chunk) => {
    target.write(chunk);
    output += chunk.toString();
  });
}

const exitCode = await new Promise((resolve) => {
  child.on("error", (error) => {
    output += `\nTest runner failed to start: ${error.message}\n`;
    resolve(1);
  });
  child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});

await writeFile(logPath, output);
process.exitCode = exitCode;
