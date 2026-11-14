import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ChecksUnavailable,
  GhGitHubReader,
  PR_CHECK_ROLLUP_QUERY,
  resolveChecks,
} from "../plugins/pstack/skills/poteto-mode/scripts/watch-pr/github.ts";

const head = "a66c327af02be3cd643c1f0a163ee00967fbc6c0";
const context = { owner: "owner", repo: "repo", number: 42 };
const suite = (status = "completed", conclusion = "action_required") => ({
  head_sha: head,
  status,
  conclusion,
});

// Model the transport, not the resolver. The no-run/action_required shape was
// observed on a fork PR: GitHub has an approval-gated suite and zero check runs.
function fixture({ suites = [], pages, rollup = null, denied = false, fast = null } = {}) {
  const calls = [];
  const reader = new GhGitHubReader({ remaining: () => 60 });
  reader.run = async (args) => {
    assert.equal(args[1], "pr");
    assert.equal(args[2], "checks");
    return fast === null
      ? { code: 1, stdout: "", stderr: "no checks reported on the 'feature' branch" }
      : { code: 0, stdout: JSON.stringify(fast), stderr: "" };
  };
  reader.runJson = async (args) => {
    calls.push(args);
    if (args[2] === "graphql") {
      assert.ok(args.includes(`query=${PR_CHECK_ROLLUP_QUERY}`));
      return { data: { repository: { pullRequest: {
        commits: { nodes: [{ commit: { oid: head, statusCheckRollup: rollup } }] },
      } } } };
    }
    assert.deepEqual(args, [
      "gh", "api", "--paginate", "--slurp",
      `repos/owner/repo/commits/${head}/check-suites?per_page=100`,
    ]);
    if (denied) throw new Error("HTTP 403: check suites are not readable");
    return pages ?? [{ total_count: suites.length, check_suites: suites }];
  };
  return { reader, calls, read: () => resolveChecks(reader, context) };
}

for (const conclusion of ["action_required", "failure", "cancelled", "timed_out", "startup_failure"]) {
  test(`a head with an unreported ${conclusion} suite is not no-CI`, async () => {
    const f = fixture({ suites: [suite("completed", conclusion)] });
    await assert.rejects(f.read, (error) =>
      error instanceof ChecksUnavailable && error.message.includes("not a repository without CI"));
  });
}

for (const status of ["queued", "in_progress", "waiting", "requested"]) {
  test(`an unreported ${status} suite does not start the no-CI clock`, async () => {
    const f = fixture({ suites: [suite(status, null)] });
    await assert.rejects(f.read, ChecksUnavailable);
  });
}

test("the approval error names the action rather than a failing test", async () => {
  const f = fixture({ suites: [suite()] });
  await assert.rejects(f.read, /requires maintainer approval or other action/);
});

test("a gated suite on a later page is not hidden by a successful one", async () => {
  const f = fixture({ pages: [
    { total_count: 2, check_suites: [suite("completed", "success")] },
    { total_count: 2, check_suites: [suite()] },
  ] });
  await assert.rejects(f.read, ChecksUnavailable);
});

test("a repository with no suites can still be reported as no-checks", async () => {
  const f = fixture();
  assert.deepEqual(await f.read(), { kind: "no-checks", checks: [] });
  assert.equal(f.calls.length, 2);
});

for (const conclusion of ["success", "neutral", "skipped"]) {
  test(`a completed ${conclusion} suite without jobs is not an approval blocker`, async () => {
    const f = fixture({ suites: [suite("completed", conclusion)] });
    assert.deepEqual(await f.read(), { kind: "no-checks", checks: [] });
  });
}

test("an unreadable suite response is not proof of absent CI", async () => {
  await assert.rejects(fixture({ denied: true }).read, /HTTP 403/);
});

test("a missing suite page is not an empty suite list", async () => {
  await assert.rejects(fixture({ pages: [] }).read, /check suite pages/);
});

test("a malformed suite response is not proof of absent CI", async () => {
  await assert.rejects(fixture({ pages: [{ total_count: 1 }] }).read, /check_suites/);
});

test("suite facts from a different head cannot certify the current head", async () => {
  const f = fixture({ suites: [{ ...suite("completed", "success"), head_sha: "b".repeat(40) }] });
  await assert.rejects(f.read, /must match the queried head/);
});

test("the query requests the immutable commit used by the suite lookup", () => {
  assert.match(PR_CHECK_ROLLUP_QUERY, /commit\s*\{\s*oid\s+statusCheckRollup/);
});

test("reported fast-path checks do not add a suite lookup", async () => {
  const f = fixture({ fast: [{ name: "test", state: "SUCCESS", bucket: "pass" }] });
  assert.equal((await f.read()).kind, "reported");
  assert.equal(f.calls.length, 0);
});

test("a reported GraphQL check keeps its existing classification", async () => {
  const f = fixture({ rollup: { contexts: {
    nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } });
  const result = await f.read();
  assert.equal(result.kind, "reported");
  assert.equal(result.checks[0].kind, "failed");
  assert.equal(f.calls.length, 1);
});
