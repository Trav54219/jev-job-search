/**
 * JEV's typed questions asked of an ordinary chat model through an OpenAI-compatible gateway
 * (Open Gateway by default), for a person who has no OpenRouter key. The model is asked for a
 * probability per outcome; code turns those into the same answers the Decisions API returns:
 * a choice is the most likely option and its probability is the confidence, a score is the
 * probability-weighted level. Every reply is parsed with a schema, and a question left out or
 * answered in another shape fails the call, exactly as with JEV.
 */
import { z } from "zod";
import { JEV_GATEWAY } from "../config.js";
import type { Answer, DecisionResponse, Question, Questions, State } from "./types.js";

/** The reply as a plain object; each answer is read and checked on its own, so one bad answer does not sink the rest. */
const Reply = z.record(z.unknown());
type Raw = { p?: number; probabilities?: Record<string, number> };

function readRaw(v: unknown): Raw | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { p?: unknown; probabilities?: unknown };
  const out: Raw = {};
  if (o.p !== undefined) out.p = Number(o.p);
  if (o.probabilities && typeof o.probabilities === "object") out.probabilities = Object.fromEntries(Object.entries(o.probabilities as Record<string, unknown>).map(([k, x]) => [k, Number(x)]));
  return out;
}

const SYSTEM = [
  "You answer typed questions about a STATE (a job posting, a form, a page, a candidate) with calibrated probabilities.",
  "Use only what the STATE says. Never assume a fact about the candidate that the STATE does not give.",
  "Reply with one JSON object and nothing else. It has one key per question, the same keys you were given.",
  'For a "noul" question: {"p": <probability from 0 to 1 that the answer is true>}.',
  'For a "choice" question: {"probabilities": {<every option key>: <probability>}}, summing to 1.',
  'For a "score" question: {"probabilities": {"0": <p>, "1": <p>, ...}} over the level indexes, lowest first, summing to 1.',
  "When the STATE does not settle a question, spread the probability; do not guess with certainty.",
].join("\n");

/** The questions as the model reads them: each outcome with its definition. */
export function describeQuestions(questions: Questions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") out[key] = { type: "noul", question: q.instructions, ...(q.criteria ? { true_means: q.criteria.true, false_means: q.criteria.false } : {}) };
    else if (q.type === "choice") out[key] = { type: "choice", question: q.instructions, options: q.criteria };
    else out[key] = { type: "score", question: q.instructions, levels: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])) };
  }
  return out;
}

export function buildMessages(state: State, questions: Questions): { role: string; content: string }[] {
  const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 1);
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `STATE:\n${stateText}\n\nQUESTIONS:\n${JSON.stringify(describeQuestions(questions), null, 1)}` },
  ];
}

/** Probabilities over the keys a question allows, renormalized; null when none of them was given. */
function normalize(raw: Record<string, number> | undefined, keys: string[]): Record<string, number> | null {
  if (!raw) return null;
  const vals = keys.map((k) => Math.max(0, Number.isFinite(raw[k]) ? (raw[k] as number) : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return Object.fromEntries(keys.map((k, i) => [k, (vals[i] as number) / sum]));
}

function toAnswer(q: Question, r: { p?: number; probabilities?: Record<string, number> } | undefined): Answer | null {
  if (!r) return null;
  if (q.type === "noul") {
    if (r.p === undefined || !Number.isFinite(r.p)) return null;
    return { type: "noul", noul: Math.min(1, Math.max(0, r.p)) };
  }
  if (q.type === "choice") {
    const probs = normalize(r.probabilities, Object.keys(q.criteria));
    if (!probs) return null;
    const [choice, confidence] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0] as [string, number];
    return { type: "choice", choice, probabilities: probs, confidence };
  }
  const keys = q.criteria.map((_, i) => String(i));
  const probs = normalize(r.probabilities, keys);
  if (!probs) return null;
  const score = keys.reduce((s, k, i) => s + i * (probs[k] as number), 0);
  const confidence = Math.max(...Object.values(probs));
  return { type: "score", score, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities: probs, confidence };
}

/** Turns the model's JSON into Decisions API answers. Throws when the reply is not JSON; leaves out what it cannot read, so the caller reports the missing keys. */
export function parseReply(text: string, questions: Questions): Record<string, Answer> {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const reply = Reply.parse(JSON.parse(json));
  const answers: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = toAnswer(q, readRaw(reply[key]));
    if (a) answers[key] = a;
  }
  return answers;
}

const ChatReply = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

/** The request body for one call. */
export function chatBody(model: string, state: State, questions: Questions): string {
  return JSON.stringify({
    model,
    messages: buildMessages(state, questions),
    temperature: 0,
    max_tokens: JEV_GATEWAY.maxOutputTokens,
    response_format: { type: "json_object" },
  });
}

/** Reads a gateway reply into the shape the JEV client already handles. */
export function toDecision(text: string, questions: Questions): DecisionResponse {
  const parsed = ChatReply.parse(JSON.parse(text));
  const content = parsed.choices[0]?.message.content ?? "";
  const input = parsed.usage?.prompt_tokens ?? 0;
  const output = parsed.usage?.completion_tokens ?? 0;
  const cost = (input * JEV_GATEWAY.pricePerMillion.input + output * JEV_GATEWAY.pricePerMillion.output) / 1_000_000;
  return {
    ...(parsed.id ? { id: parsed.id } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    provider: "opengateway",
    answers: parseReply(content, questions),
    usage: { input_tokens: input, output_tokens: output, cost },
  };
}
