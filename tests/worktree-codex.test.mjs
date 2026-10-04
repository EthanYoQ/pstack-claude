import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { audit, defaultTranscriptRoots, lastChats } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";

const roots = [];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const temporary = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-codex-audit-")));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function transcript(path, cwd, compressed = false) {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "fixture", cwd } }) + "\n";
  writeFileSync(path, compressed ? zstdCompressSync(Buffer.from(text)) : text);
}

function fixture() {
  const home = temporary();
  const seed = join(home, "seed");
  git("init", "--initial-branch=main", seed);
  git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const remote = join(home, "remote.git");
  git("clone", "--bare", seed, remote);
  const repo = join(home, "repo");
  git("clone", remote, repo);
  const worktree = join(home, "candidate");
  git("-C", repo, "worktree", "add", "-b", "candidate", worktree);
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  return { home, repo, worktree };
}

for (const [directory, compressed] of [["sessions", false], ["archived_sessions", false], ["sessions", true]]) {
  test(`default discovery protects a recent Codex ${directory} ${compressed ? "compressed" : "plain"} rollout`, () => {
    const f = fixture();
    transcript(join(f.home, ".codex", directory, "2026", "10", "05", `rollout.jsonl${compressed ? ".zst" : ""}`), f.worktree, compressed);
    const output = audit({ repo: f.repo, transcripts: defaultTranscriptRoots({ home: f.home, env: {} }), gh: () => "[]" });
    const row = output.trimEnd().split("\n")[1].split("\t");
    expect(row[2]).toBe("YES");
    expect(row[7]).toBe("verify-recent-chat");
    expect(row[6]).not.toBe("-");
  });
}

test("CODEX_HOME replaces the default Codex root and includes both live and archived sessions", () => {
  const home = temporary();
  const custom = join(home, "custom codex");
  const expected = [join(custom, "sessions"), join(custom, "archived_sessions")];
  for (const path of [...expected, join(home, ".codex", "sessions")]) mkdirSync(path, { recursive: true });
  expect(defaultTranscriptRoots({ home, env: { CODEX_HOME: custom } })).toEqual(expected);
});

for (const [worktree, cwd] of [
  ["C:/Users/Dev/project", "C:\\Users\\Dev\\project"],
  ["C:\\Users\\Dev\\project", "c:/users/dev/project/src/file.ts"],
  ["/tmp/project\"quoted", "/tmp/project\"quoted/src/file.ts"],
  ["/tmp/project\\literal", "/tmp/project\\literal"],
]) {
  test(`JSON-encoded transcript paths match ${JSON.stringify(worktree)}`, () => {
    const root = temporary();
    transcript(join(root, "rollout.jsonl"), cwd);
    const chats = lastChats([root], [worktree, worktree + "-other"]);
    expect(chats.has(worktree)).toBe(true);
    expect(chats.has(worktree + "-other")).toBe(false);
  });
}

test("a sibling path with the same prefix is not activity in this worktree", () => {
  const root = temporary();
  transcript(join(root, "rollout.jsonl"), "C:\\work\\candidate-long");
  expect(lastChats([root], ["C:/work/candidate"]).size).toBe(0);
});

test("an unreadable compressed rollout makes the audit review, not safe", () => {
  const f = fixture();
  const sessions = join(f.home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout.jsonl.zst"), "not zstd");
  const warnings = [];
  const output = audit({ repo: f.repo, transcripts: [sessions], gh: () => "[]", warn: (line) => warnings.push(line) });
  expect(output.trimEnd().split("\n")[1].split("\t")[7]).toBe("review");
  expect(warnings.join("\n")).toContain("transcript scan failed");
});


test("a worktree alias matches the transcript's canonical directory", () => {
  const root = temporary();
  const target = join(root, "canonical");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias, "junction");
  transcript(join(root, "rollout.jsonl"), realpathSync(target));
  expect(lastChats([root], [alias]).has(alias)).toBe(true);
});
