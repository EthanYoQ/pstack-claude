// Real filesystem failures, rather than a directory standing in for an unreadable file.
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readSheet } from "../../plugins/pstack/pi/config.ts";
import { flag, pluginRoot, useWorld } from "./harness.mjs";

const setup = useWorld();
const sheetText = "session hook: off\npi models: sonnet=openai/sheet-sonnet\n";

// Windows permissions are not controlled by chmod, and root can read mode 000.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable Pi sheet", () => {
  for (const target of ["file", "directory"]) {
    test(`a permission error on the ${target} leaves the sheet absent`, () => {
      const { w } = setup({ sheet: sheetText });
      const sheet = join(w.agentDir, "pstack-models.md");
      const locked = target === "file" ? sheet : w.agentDir;
      chmodSync(locked, 0o000);
      try {
        expect(() => readFileSync(sheet, "utf8")).toThrow();
        expect(readSheet(w.agentDir)).toBeUndefined();
      } finally {
        chmodSync(locked, target === "file" ? 0o600 : 0o700);
      }
      expect(readSheet(w.agentDir)).toMatchObject({ text: sheetText, hookOff: true });
    });
  }

  test("routing and agent launches use defaults until the sheet is readable again", async () => {
    const { w, pi, ctx } = setup({ sheet: sheetText });
    const sheet = join(w.agentDir, "pstack-models.md");
    const sections = async () => {
      const event = { prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: {} } };
      await pi.emit("before_agent_start", event, ctx);
      return event.systemPromptOptions.sections;
    };
    const launch = () => pi.call("agent", { description: "read sheet", prompt: "x", model: "sonnet" }, ctx);
    chmodSync(sheet, 0o000);
    try {
      expect(() => readFileSync(sheet, "utf8")).toThrow();
      const injected = await sections();
      expect(injected["pstack-session-start"]).toBe(readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8"));
      expect(injected["pstack-pi-tools"]).toContain("pi-tools.md");
      expect(injected["pstack-models"]).toBeUndefined();
      expect((await launch()).details.status).toBe("completed");
      expect(flag(w.invocations().at(-1), "--model")).toBe("anthropic/fixture-sonnet");
    } finally {
      chmodSync(sheet, 0o600);
    }
    const restored = await sections();
    expect(restored["pstack-session-start"]).toBeUndefined();
    expect(restored["pstack-models"]).toBe(sheetText);
    expect((await launch()).details.status).toBe("completed");
    expect(flag(w.invocations().at(-1), "--model")).toBe("openai/sheet-sonnet");
  });
});
