/**
 * HTTP client for the OpenRouter Decisions API.
 *
 * One call = one state + many typed questions. Answers come back under the
 * same keys. The client validates the response, retries transient failures,
 * tracks spend, and refuses to exceed a per-run spend cap.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { JEV, JEV_CLAUDE, JEV_GATEWAY, jevBackend, PATHS, type JevBackend } from "../config.js";
import { claudeDecision, runClaude, type ClaudeRunner } from "./claudeCode.js";
import { chatBody, toDecision } from "./gateway.js";
import { DecisionResponse, type Answer, type Questions, type State, type Usage } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type JevClientOptions = {
  apiKey?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
  model?: string;
  spendCapUsd?: number;
  /** When set, every call's usage is appended as JSON lines here. */
  usageLog?: string | null;
  siteUrl?: string;
  siteName?: string;
  /** For JEV_BACKEND=claude-code: how a prompt reaches Claude Code. Replaceable in a test. */
  claudeRunner?: ClaudeRunner;
};

export class JevError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private readonly apiKey: string;
  /** With claude-code: the Open Gateway key a failed call falls back to, or "" for none. */
  private readonly fallbackKey: string;
  private readonly claudeRunner: ClaudeRunner;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly spendCapUsd: number;
  private readonly usageLog: string | null;
  private readonly siteUrl: string | undefined;
  private readonly siteName: string | undefined;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  /** "opengateway" asks a chat model the same questions (src/jev/gateway.ts); "claude-code" asks Claude Code on the subscription (src/jev/claudeCode.ts). */
  readonly backend: JevBackend;

  constructor(opts: JevClientOptions & { backend?: JevBackend } = {}) {
    this.backend = opts.backend ?? jevBackend();
    this.claudeRunner = opts.claudeRunner ?? runClaude;
    const viaClaude = this.backend === "claude-code";
    // Claude Code needs no key; its fallback is the Open Gateway key when there is one.
    this.fallbackKey = viaClaude ? (opts.apiKey ?? process.env.OPENGATEWAY_API_KEY ?? "").trim() : "";
    const gateway = this.backend === "opengateway" || viaClaude;
    const key = viaClaude ? this.fallbackKey || "none" : opts.apiKey ?? (gateway ? process.env.OPENGATEWAY_API_KEY : process.env.OPENROUTER_API_KEY);
    if (!key) throw new JevError(gateway ? "OPENGATEWAY_API_KEY is not set. Add it to .env." : "OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key, or set JEV_BACKEND=opengateway with OPENGATEWAY_API_KEY.");
    this.apiKey = key;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = opts.endpoint ?? (gateway ? JEV_GATEWAY.endpoint : JEV.endpoint);
    this.model = opts.model ?? (gateway ? JEV_GATEWAY.model : JEV.model);
    this.spendCapUsd = opts.spendCapUsd ?? JEV.runSpendCapUsd;
    this.usageLog = opts.usageLog === undefined ? PATHS.jevUsage : opts.usageLog;
    this.siteUrl = opts.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.siteName = opts.siteName ?? process.env.OPENROUTER_SITE_NAME;
  }

  /** Asks every question against one state. Throws JevError on a non-recoverable failure. */
  async decide(state: State, questions: Questions, label = "decide"): Promise<Record<string, Answer>> {
    if (Object.keys(questions).length === 0) return {};
    if (this.usage.costUsd >= this.spendCapUsd) {
      throw new JevError(`JEV spend cap of $${this.spendCapUsd} reached for this run`);
    }
    if (this.backend === "claude-code") return this.decideByClaude(state, questions, label);
    return this.decideOverHttp(state, questions, label);
  }

  /** Claude Code first; when it fails every try, Open Gateway takes the call if a key is set. */
  private async decideByClaude(state: State, questions: Questions, label: string): Promise<Record<string, Answer>> {
    let last: unknown;
    for (let attempt = 0; attempt < JEV_CLAUDE.attempts; attempt++) {
      try {
        const parsed = DecisionResponse.safeParse(await claudeDecision(state, questions, this.claudeRunner));
        if (!parsed.success) throw new JevError(`Claude Code returned an unexpected shape on ${label}: ${parsed.error.message}`);
        this.assertAllAnswered(questions, parsed.data.answers, label, 502);
        this.record(parsed.data, label);
        return parsed.data.answers;
      } catch (err) {
        last = err;
      }
    }
    if (this.fallbackKey) return this.decideOverHttp(state, questions, `${label} (Open Gateway fallback)`);
    throw last instanceof JevError ? last : new JevError(`Claude Code failed on ${label}: ${redact(String(last))}`);
  }

  private async decideOverHttp(state: State, questions: Questions, label: string): Promise<Record<string, Answer>> {
    const gateway = this.backend !== "openrouter";
    const body = gateway ? chatBody(this.model, state, questions) : JSON.stringify({ model: this.model, state, questions });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (this.siteName) headers["X-OpenRouter-Title"] = this.siteName;

    let lastError: JevError | undefined;
    for (let attempt = 0; attempt <= JEV.maxRetries; attempt++) {
      if (attempt > 0) await sleep(JEV.retryBaseMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), gateway ? JEV_GATEWAY.timeoutMs : JEV.timeoutMs);
      try {
        const res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body, signal: controller.signal });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastError = new JevError(`JEV ${res.status} on ${label}`, res.status, redact(text));
          continue;
        }
        if (!res.ok) throw new JevError(`JEV ${res.status} on ${label}: ${redact(text)}`, res.status, redact(text));
        let decoded: unknown;
        try {
          decoded = gateway ? toDecision(text, questions) : JSON.parse(text);
        } catch (e) {
          // A chat model can slip once; its reply is asked for again like a busy server.
          throw new JevError(`JEV returned an unreadable reply on ${label}: ${redact(String(e)).slice(0, 200)}`, 502);
        }
        const parsed = DecisionResponse.safeParse(decoded);
        if (!parsed.success) throw new JevError(`JEV returned an unexpected shape on ${label}: ${parsed.error.message}`);
        this.record(parsed.data, label);
        this.assertAllAnswered(questions, parsed.data.answers, label, gateway ? 502 : undefined);
        return parsed.data.answers;
      } catch (err) {
        if (err instanceof JevError) {
          if (err.status === undefined || (err.status !== 429 && err.status < 500)) throw err;
          lastError = err;
          continue;
        }
        const name = (err as { name?: string }).name;
        lastError = new JevError(`${name === "AbortError" ? "JEV timeout" : "JEV network error"} on ${label}: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new JevError(`JEV failed on ${label}`);
  }

  private record(res: DecisionResponse, label: string): void {
    const u = res.usage ?? {};
    this.usage.calls += 1;
    this.usage.inputTokens += u.input_tokens ?? 0;
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.costUsd += u.cost ?? 0;
    if (!this.usageLog) return;
    try {
      mkdirSync(path.dirname(this.usageLog), { recursive: true });
      appendFileSync(
        this.usageLog,
        JSON.stringify({ at: new Date().toISOString(), label, id: res.id, model: res.model, ...u }) + "\n",
      );
    } catch {
      /* usage logging is best effort */
    }
  }

  private assertAllAnswered(questions: Questions, answers: Record<string, Answer>, label: string, retryStatus?: number): void {
    const missing = Object.keys(questions).filter((k) => !(k in answers));
    if (missing.length) throw new JevError(`JEV left questions unanswered on ${label}: ${missing.join(", ")}`, retryStatus);
    for (const [key, q] of Object.entries(questions)) {
      const a = answers[key];
      if (a && a.type !== q.type) throw new JevError(`JEV answered ${key} as ${a.type}, expected ${q.type}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strips anything that looks like a bearer token from an error body before it is surfaced. */
function redact(text: string): string {
  return text.replace(/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1-[redacted]").slice(0, 500);
}
