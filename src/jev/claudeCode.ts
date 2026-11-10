/**
 * JEV's typed questions asked of Claude Code, headless, on the person's own subscription
 * (JEV_BACKEND=claude-code). Same prompt and same parsing as the gateway (src/jev/gateway.ts):
 * the model gives probabilities, code turns them into Decisions API answers. No API credit is
 * spent, so the cost recorded is 0. Claude Code runs with no tools, no session and no MCP.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { childEnv, JEV_CLAUDE, WRITER } from "../config.js";
import { buildMessages, parseReply, SYSTEM } from "./gateway.js";
import type { DecisionResponse, Questions, State } from "./types.js";

/** Runs one prompt and returns Claude Code's JSON envelope as text. Replaceable in a test. */
export type ClaudeRunner = (prompt: string, system: string) => Promise<string>;

type Envelope = { result?: unknown; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } };

/** Claude Code's own sign-in on a machine with no Keychain, handed only to this child. */
function login(): Record<string, string> {
  const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

export const runClaude: ClaudeRunner = (prompt, system) =>
  new Promise((resolve, reject) => {
    mkdirSync(WRITER.cwd, { recursive: true });
    const child = spawn(
      WRITER.command,
      ["-p", "--model", JEV_CLAUDE.model, "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--system-prompt", system],
      { stdio: ["pipe", "pipe", "pipe"], cwd: WRITER.cwd, env: childEnv(login()) },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Claude Code did not answer in ${JEV_CLAUDE.timeoutMs / 1000}s`));
    }, JEV_CLAUDE.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${WRITER.command}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Claude Code exited with ${code}: ${err.slice(0, 200)}`));
      resolve(out);
    });
    child.stdin.end(prompt);
  });

/** Asks the questions through Claude Code and reads the reply into the shape the JEV client handles. Throws on an unreadable reply. */
export async function claudeDecision(state: State, questions: Questions, run: ClaudeRunner = runClaude): Promise<DecisionResponse> {
  const user = buildMessages(state, questions).find((m) => m.role === "user")?.content ?? "";
  const envelope = JSON.parse(await run(user, SYSTEM)) as Envelope;
  if (envelope.is_error || typeof envelope.result !== "string") throw new Error(`Claude Code failed: ${String(envelope.result).slice(0, 200)}`);
  return {
    provider: "claude-code",
    answers: parseReply(envelope.result, questions),
    usage: { input_tokens: envelope.usage?.input_tokens ?? 0, output_tokens: envelope.usage?.output_tokens ?? 0, cost: 0 },
  };
}
