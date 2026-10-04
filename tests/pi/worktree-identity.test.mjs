import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorktree, planWorktree, settleWorktree } from "../../plugins/pstack/pi/worktree.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function initialize(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
}
function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-worktree-identity-")));
  const repo = join(root, "repo");
  try {
    initialize(repo);
    return run({ root, repo, wt: planWorktree(repo, "identity-test") });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("rejects an ordinary existing directory instead of inheriting the primary Git checkout", () => fixture(({ repo, wt }) => {
  mkdirSync(wt.path, { recursive: true });
  assert.equal(realpathSync(git(wt.path, "rev-parse", "--show-toplevel")), realpathSync(repo));
  assert.throws(() => ensureWorktree(wt), /not the expected linked worktree/);
}));

test("rejects an unrelated repository that occupies the saved path", () => fixture(({ wt }) => {
  initialize(wt.path);
  const head = git(wt.path, "rev-parse", "HEAD");
  assert.throws(() => ensureWorktree(wt), /not the expected linked worktree/);
  assert.equal(git(wt.path, "rev-parse", "HEAD"), head);
}));

test("rejects a symlink or junction to the primary checkout", () => fixture(({ repo, wt }) => {
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
  symlinkSync(repo, wt.path, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => ensureWorktree(wt), /not the expected linked worktree/);
}));

test("rejects a symlink or junction to another agent's legitimate worktree", () => fixture(({ repo, wt }) => {
  const other = planWorktree(repo, "other-agent");
  ensureWorktree(other);
  symlinkSync(other.path, wt.path, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => ensureWorktree(wt), /not the expected linked worktree/);
  assert.ok(existsSync(other.path));
}));

test("rejects an unregistered gitdir indirection to the primary index", () => fixture(({ repo, wt }) => {
  mkdirSync(wt.path, { recursive: true });
  writeFileSync(join(wt.path, ".git"), `gitdir: ${join(repo, ".git").replaceAll("\\", "/")}\n`);
  assert.throws(() => ensureWorktree(wt), /not the expected linked worktree/);
}));

test("a retained worktree replaced by a plain directory cannot be resumed", () => fixture(({ repo, wt }) => {
  ensureWorktree(wt);
  git(repo, "worktree", "remove", wt.path);
  mkdirSync(wt.path, { recursive: true });
  writeFileSync(join(wt.path, "keep.txt"), "do not remove\n");
  assert.throws(() => ensureWorktree(wt), /not the expected linked worktree/);
  assert.equal(readFileSync(join(wt.path, "keep.txt"), "utf8"), "do not remove\n");
}));

test("cleanup refuses a replacement directory without deleting its files or branch", () => fixture(({ repo, wt }) => {
  ensureWorktree(wt);
  git(repo, "worktree", "remove", wt.path);
  mkdirSync(wt.path, { recursive: true });
  writeFileSync(join(wt.path, "keep.txt"), "do not remove\n");
  assert.throws(() => settleWorktree(wt), /not the expected linked worktree/);
  assert.equal(readFileSync(join(wt.path, "keep.txt"), "utf8"), "do not remove\n");
  assert.ok(git(repo, "branch", "--list", wt.branch).includes(wt.branch));
}));

test("accepts a legitimate existing worktree and still removes a clean one", () => fixture(({ repo, wt }) => {
  ensureWorktree(wt);
  ensureWorktree(wt);
  assert.equal(realpathSync(git(wt.path, "rev-parse", "--show-toplevel")), realpathSync(wt.path));
  assert.equal(settleWorktree(wt), false);
  assert.equal(existsSync(wt.path), false);
  assert.equal(git(repo, "branch", "--list", wt.branch), "");
}));

test("recreates a cleanly removed worktree when resuming", () => fixture(({ wt }) => {
  ensureWorktree(wt);
  assert.equal(settleWorktree(wt), false);
  ensureWorktree(wt);
  assert.equal(git(wt.path, "rev-parse", "HEAD"), wt.base);
}));

test("keeps a detached-HEAD commit and allows its checkout to be resumed", () => fixture(({ wt }) => {
  ensureWorktree(wt);
  git(wt.path, "checkout", "--detach");
  writeFileSync(join(wt.path, "important.txt"), "keep\n");
  git(wt.path, "add", "important.txt");
  git(wt.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "detached work");
  ensureWorktree(wt);
  assert.equal(settleWorktree(wt), true);
  assert.ok(existsSync(join(wt.path, "important.txt")));
}));

test("supports a parent session already in a linked worktree", () => fixture(({ repo, root }) => {
  const parent = join(root, "parent-worktree");
  git(repo, "worktree", "add", "-b", "parent", parent);
  const child = planWorktree(parent, "nested-agent");
  ensureWorktree(child);
  ensureWorktree(child);
  assert.equal(git(child.path, "rev-parse", "HEAD"), child.base);
  assert.equal(settleWorktree(child), false);
}));

test("a missing worktree still requires no cleanup", () => fixture(({ wt }) => {
  assert.equal(settleWorktree(wt), false);
}));
