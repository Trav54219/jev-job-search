import { describe, expect, it } from "vitest";
import { JevClient, JevError } from "../src/jev/client.js";
import type { Questions } from "../src/jev/types.js";

const questions: Questions = {
  remote: { type: "noul", instructions: "Is the role remote?" },
  level: { type: "choice", instructions: "Which level?", criteria: { junior: "entry", senior: "senior" } },
};
const envelope = (result: unknown) => JSON.stringify({ type: "result", is_error: false, result, usage: { input_tokens: 120, output_tokens: 30 } });
const good = envelope(JSON.stringify({ remote: { p: 0.9 }, level: { probabilities: { senior: 0.8, junior: 0.2 } } }));

describe("JEV on Claude Code", () => {
  it("answers through Claude Code and records no cost", async () => {
    const prompts: string[] = [];
    const jev = new JevClient({ backend: "claude-code", apiKey: "", usageLog: null, claudeRunner: async (p) => (prompts.push(p), good) });
    const a = await jev.decide("A remote senior role", questions);
    expect(a.remote).toEqual({ type: "noul", noul: 0.9 });
    expect(a.level?.type === "choice" && a.level.choice).toBe("senior");
    expect(jev.usage.costUsd).toBe(0);
    expect(jev.usage.calls).toBe(1);
    expect(prompts[0]).toContain("STATE:");
  });

  it("asks again when Claude Code leaves a question out", async () => {
    let n = 0;
    const partial = envelope(JSON.stringify({ remote: { p: 0.4 } }));
    const jev = new JevClient({ backend: "claude-code", apiKey: "", usageLog: null, claudeRunner: async () => (n++ ? good : partial) });
    await jev.decide("state", questions);
    expect(n).toBe(2);
  });

  it("falls back to Open Gateway when Claude Code fails every try", async () => {
    const calls: string[] = [];
    const jev = new JevClient({
      backend: "claude-code",
      apiKey: "gw-test",
      usageLog: null,
      claudeRunner: async () => {
        throw new Error("not logged in");
      },
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.parse(JSON.parse(good).result) ? JSON.parse(good).result : "" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
      },
    });
    const a = await jev.decide("state", questions);
    expect(calls).toHaveLength(1);
    expect(a.remote?.type).toBe("noul");
  });

  it("fails with no fallback key", async () => {
    const jev = new JevClient({
      backend: "claude-code",
      apiKey: "",
      usageLog: null,
      claudeRunner: async () => {
        throw new Error("not logged in");
      },
    });
    await expect(jev.decide("state", questions)).rejects.toBeInstanceOf(JevError);
  });
});
