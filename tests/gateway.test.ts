import { describe, expect, it } from "vitest";
import { JevClient } from "../src/jev/client.js";
import { parseReply, toDecision } from "../src/jev/gateway.js";
import { choice, noul, score } from "../src/jev/questions.js";

const qs = {
  remote: noul("Is it remote?"),
  level: choice("Which level?", { junior: "0-2 years", mid: "2-5 years", senior: "5+" }),
  fit: score("How good a fit?", ["None", "Weak", "Strong"]),
};

describe("gateway answers", () => {
  it("turns probabilities into JEV answers", () => {
    const a = parseReply('```json\n{"remote":{"p":0.9},"level":{"probabilities":{"junior":0.1,"mid":0.6,"senior":0.1}},"fit":{"probabilities":{"0":0,"1":0.5,"2":0.5}}}\n```', qs);
    expect(a.remote).toEqual({ type: "noul", noul: 0.9 });
    expect(a.level).toMatchObject({ type: "choice", choice: "mid", confidence: 0.75 });
    expect(a.fit).toMatchObject({ type: "score", score: 1.5, confidence: 0.5, legend: { "0": "None", "2": "Strong" } });
  });
  it("leaves out an answer it cannot read, and ignores invented options", () => {
    const a = parseReply('{"remote":{"p":"x"},"level":{"probabilities":{"cto":1}}}', qs);
    expect(Object.keys(a)).toEqual([]);
  });
  it("prices a call from its token counts", () => {
    const d = toDecision(JSON.stringify({ choices: [{ message: { content: '{"remote":{"p":0.2}}' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }), { remote: qs.remote });
    expect(d.usage?.cost).toBeCloseTo(0.1);
    expect(d.answers.remote).toEqual({ type: "noul", noul: 0.2 });
  });
  it("asks again when the model leaves a question out, then fails", async () => {
    let calls = 0;
    const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });
    const jev = new JevClient({ backend: "opengateway", apiKey: "test", usageLog: null, fetchImpl: async () => (++calls === 1 ? reply("{}") : reply('{"remote":{"p":1}}')) });
    expect(await jev.decide("x", { remote: qs.remote })).toEqual({ remote: { type: "noul", noul: 1 } });
    expect(calls).toBe(2);
    const never = new JevClient({ backend: "opengateway", apiKey: "test", usageLog: null, fetchImpl: async () => reply("not json") });
    await expect(never.decide("x", { remote: qs.remote })).rejects.toThrow(/unreadable/);
  });
});
