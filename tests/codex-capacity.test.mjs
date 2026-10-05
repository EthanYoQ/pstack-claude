// Codex dispatch is prompt-driven, not a pstack runtime scheduler. These are
// instruction-contract regressions; they do not simulate a live Codex host.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const mapping = readFileSync(
  new URL("../plugins/pstack/skills/poteto-mode/references/codex-tools.md", import.meta.url),
  "utf8",
);

function section(heading) {
  const start = mapping.indexOf(`${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return mapping.slice(start + heading.length + 1).split(/^## /m)[0];
}

describe("Codex subagent capacity contract", () => {
  test("the shared policy and review entry point require the Codex mapping", () => {
    for (const [skill, pointer] of [
      ["poteto-mode", "On Codex, read [`references/codex-tools.md`](references/codex-tools.md)"],
      ["interrogate", "On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md)"],
    ]) {
      const entry = readFileSync(new URL(`../plugins/pstack/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
      expect(entry).toContain(pointer);
    }
  });

  test("tool mappings do not promise an unavailable close tool or unbounded fan-out", () => {
    const actions = section("## Tool actions");
    expect(actions).toContain("The current session's exposed tools and their schemas are authoritative");
    expect(actions).toContain("within available capacity; see Capacity and independent reviews below");
    expect(actions).toContain("`close_agent` only if exposed by this session");
    expect(actions).not.toContain("| Free a finished subagent slot | `close_agent` |");
  });

  test("unavailable multi_agent permits only a labelled exploratory fallback", () => {
    const actions = section("## Tool actions");
    expect(actions).toContain("Exploratory work may use a labelled single-agent sequential pass");
    expect(actions).toContain("A required independent review remains blocked");
  });

  test("a capacity rejection takes precedence over fresh-agent and model-fallback instructions", () => {
    const policy = section("## Subagent policy");
    expect(policy).toContain("This Codex-specific exception overrides the fresh-subagent default");
    expect(policy).toContain("A thread or agent limit is a capacity error, not a rejected model slug");
    expect(policy).toContain("After the first capacity rejection, stop new spawn attempts until capacity is observably available");
    expect(policy).toContain("Do not loop on spawn, change models, or launch another batch to probe the same limit");
  });

  test("finished agents without a close tool do not imply reclaimed slots", () => {
    const policy = section("## Subagent policy");
    expect(policy).toContain("A completion notification alone does not prove its work or children have stopped");
    expect(policy).toContain("If no close tool is exposed, no slot-release action is available");
    expect(policy).toContain("Do not invent one or assume waiting, interrupting, or a completed status frees a slot");
  });

  test("reuse needs real host support, an idle reviewer, and independence from the code", () => {
    const policy = section("## Subagent policy");
    expect(policy).toContain("only if the host exposes a supported follow-up or resume action");
    expect(policy).toContain("the agent has no active work or children");
    expect(policy).toContain("must not have written or modified the change under review");
    expect(policy).toContain("its actual model and capabilities must satisfy the assigned review role");
    expect(policy).toContain("Send the complete current brief, rubric, file pointers, and exact head/base revisions");
    expect(policy).toContain("A reused reviewer counts once, not as multiple independent reviewers or models");
  });

  test("no reusable reviewer blocks the missing review without blocking unrelated work", () => {
    const policy = section("## Subagent policy");
    expect(policy).toContain("If no eligible reviewer can be dispatched or reused, record `BLOCKED: independent review`");
    expect(policy).toContain("Continue authorized work that does not depend on that review");
    expect(policy).toContain("Do not turn the lead agent's self-review, passing tests, or CI into an independent verdict");
    expect(policy).toContain("Keep review-dependent completion, merge-ready, and shipping gates closed");
  });

  test("partly dispatched panels retain real results and disclose missing coverage", () => {
    const policy = section("## Subagent policy");
    expect(policy).toContain("Keep results from reviewers already dispatched");
    expect(policy).toContain("Report requested, completed, and missing reviewers, their identities/models, and any reuse or reduced diversity");
    expect(policy).toContain("Do not describe an incomplete panel as complete or independent review as passed");
  });

  test("resuming a blocked review requires changed capacity or eligible supported reuse", () => {
    const policy = section("## Subagent policy");
    expect(policy).toContain("Record the runtime error, missing review scope, affected revisions, and recovery condition");
    expect(policy).toContain("Resume only when the host confirms capacity for the missing reviewer or an eligible reviewer becomes reusable through a supported action");
    expect(policy).toContain("Do not raise platform limits, change execution environments, or bypass permission and safety gates");
    expect(policy).toContain("A permission denial is not a capacity fallback");
  });
});
