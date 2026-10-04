import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { audit, defaultTranscriptRoots, lastChats } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";

function temporary(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-transcripts-")));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function transcript(file, value, time = new Date()) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value) + "\n");
  utimesSync(file, time, time);
}
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

for (const directory of ["sessions", "archived_sessions"]) {
  test(`default discovery includes Codex ${directory}`, () => temporary((home) => {
    const root = join(home, ".codex", directory);
    mkdirSync(root, { recursive: true });
    assert.deepEqual(defaultTranscriptRoots({ env: {}, home }), [root]);
  }));
}

test("respects CODEX_HOME and does not inspect the default Codex home instead", () => temporary((home) => {
  const custom = join(home, "custom codex");
  const roots = [join(custom, "sessions"), join(custom, "archived_sessions")];
  for (const root of [...roots, join(home, ".codex", "sessions")]) mkdirSync(root, { recursive: true });
  assert.deepEqual(defaultTranscriptRoots({ env: { CODEX_HOME: custom }, home }), roots);
}));

test("respects CLAUDE_CONFIG_DIR, as the session hook already does", () => temporary((home) => {
  const custom = join(home, "custom claude");
  mkdirSync(join(custom, "projects"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  assert.deepEqual(defaultTranscriptRoots({ env: { CLAUDE_CONFIG_DIR: custom }, home }), [join(custom, "projects")]);
}));

test("keeps Claude and Pi transcript roots alongside Codex", () => temporary((home) => {
  const pi = join(home, "custom pi");
  const roots = [join(home, ".claude", "projects"), join(home, ".codex", "sessions"), join(pi, "sessions"), join(pi, "pstack")];
  for (const root of roots) mkdirSync(root, { recursive: true });
  assert.deepEqual(defaultTranscriptRoots({ env: { PI_CODING_AGENT_DIR: pi }, home }), roots);
}));

test("retains the missing-directory sentinel when no runtime has transcripts", () => temporary((home) => {
  assert.deepEqual(defaultTranscriptRoots({ env: {}, home }), [join(home, ".claude", "projects")]);
}));

const cases = [
  { name: "a normal POSIX cwd", path: "/repo/worktree", cwd: "/repo/worktree" },
  { name: "a JSON-escaped quote", path: '/repo/with"quote', cwd: '/repo/with"quote' },
  { name: "a JSON-escaped control character", path: "/repo/with\ttab", cwd: "/repo/with\ttab" },
  { name: "Windows backslashes", path: String.raw`C:\repo\worktree`, cwd: String.raw`C:\repo\worktree` },
  { name: "Git's forward-slash Windows spelling", path: "C:/repo/worktree", cwd: String.raw`C:\repo\worktree` },
  { name: "a Windows descendant file", path: "C:/repo/worktree", cwd: String.raw`C:\repo\worktree\src\index.ts` },
  { name: "a UNC checkout", path: "//server/share/worktree", cwd: String.raw`\\server\share\worktree` },
];
for (const { name, path, cwd } of cases) {
  test(`finds recent activity for ${name}`, () => temporary((root) => {
    transcript(join(root, "2026", "10", "05", "rollout.jsonl"), { type: "session_meta", payload: { cwd } });
    assert.ok(lastChats([root], [path]).has(path));
  }));
}

for (const path of ["/repo/worktree", "C:/repo/worktree"]) {
  test(`does not confuse the prefix ${path} with a sibling`, () => temporary((root) => {
    const sibling = path.startsWith("C:") ? String.raw`C:\repo\worktree-long\src\file.ts` : `${path}-long/file.ts`;
    transcript(join(root, "sibling.jsonl"), { cwd: sibling });
    assert.equal(lastChats([root], [path]).has(path), false);
  }));
}

for (const directory of ["sessions", "archived_sessions"]) {
  test(`a recent Codex ${directory} prevents a false safe bucket with an empty Claude directory`, () => temporary((home) => {
    const repo = join(home, "repo");
    const remote = join(home, "remote.git");
    const worktree = join(home, "active-worktree");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
    git(home, "clone", "--bare", repo, remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "worktree", "add", "-b", "active", worktree);
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    transcript(join(home, ".codex", directory, "2026", "10", "05", "rollout.jsonl"), { type: "session_meta", payload: { cwd: worktree } });
    const warnings = [];
    const output = audit({ repo, transcripts: defaultTranscriptRoots({ env: {}, home }), gh: () => "[]", warn: (line) => warnings.push(line) });
    assert.deepEqual(warnings, []);
    const row = output.trim().split("\n").slice(1).map((line) => line.split("\t")).find((row) => realpathSync(row[8]) === realpathSync(worktree));
    assert.ok(row);
    assert.equal(row[7], "verify-recent-chat");
  }));
}
