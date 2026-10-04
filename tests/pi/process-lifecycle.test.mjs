import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRunner } from "../../plugins/pstack/pi/agents.ts";
import { alive } from "../../plugins/pstack/pi/child.ts";
import { fakeCtx, fakePi, pluginRoot } from "./harness.mjs";

const fixtures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const taskkill = (pid) => spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });

function running(pid) {
  if (!alive(pid)) return false;
  if (process.platform === "win32") return true;
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Process lifecycle did not settle within 5 seconds");
    await sleep(25);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pstack process lifecycle "));
  const pidFile = join(root, "pids.json");
  const script = join(root, "unresponsive.mjs");
  writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (!process.argv.includes("--descendant")) {
  const child = spawn(process.execPath, [process.argv[1], "--descendant"], { stdio: "ignore" });
  writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
}
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const pi = fakePi();
  const settings = { pluginRoot, agentDir: root, modelsFile: join(pluginRoot, "models.json"), pi: { command: process.execPath, args: [script, pidFile] }, depth: 0, killGraceMs: 100, exitGraceMs: 100 };
  const runner = new AgentRunner(pi.api, settings);
  const ctx = fakeCtx({ cwd: root });
  const record = runner.start({ description: "unresponsive agent", prompt: "test", run_in_background: true }, ctx);
  const f = { root, pidFile, pi, settings, runner, record, pids: () => existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) : [record.pid] };
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const pid of f.pids()) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (process.platform === "win32") taskkill(pid);
      else for (const target of [-pid, pid]) {
        try { process.kill(target, "SIGKILL"); } catch {}
      }
    }
    await f.runner.wait(f.record.agent.id);
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const method of ["stop", "stopAll", "signalAll"]) {
  test(`${method} ends an unresponsive agent and its descendant`, async () => {
    const f = fixture();
    await until(() => existsSync(f.pidFile));
    const pids = f.pids();
    expect(pids.every(running)).toBe(true);
    const done = f.runner[method](f.record.agent.id);
    await until(() => pids.every((pid) => !running(pid)));
    await done;
    expect((await f.runner.wait(f.record.agent.id)).status).toBe("stopped");
  }, 15000);
}

for (const matching of [true, false]) {
  test(`restore ${matching ? "reaps a matching orphan" : "leaves a reused PID alone"}`, async () => {
    const f = fixture();
    await until(() => existsSync(f.pidFile));
    const record = structuredClone(f.record);
    if (!matching) record.agent.sessionId += "-different";
    const restored = new AgentRunner(fakePi().api, f.settings);
    restored.restore([{ type: "custom", customType: "pstack-agents", data: record }]);
    if (matching) await until(() => f.pids().every((pid) => !running(pid)));
    else {
      await sleep(300);
      expect(f.pids().every(running)).toBe(true);
    }
    expect(restored.list()[0].status).toBe("stopped");
  }, 15000);
}
