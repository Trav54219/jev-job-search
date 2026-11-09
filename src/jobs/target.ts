/**
 * What kind of job the person is looking for. Without data/target.json the tool does what it was
 * built for: software internships and new-grad roles. With it, any title the person names: the
 * code filters, the JEV rating, the score and the company boards all follow the file.
 *
 *   {
 *     "roles": ["GTM Engineer", "Growth Engineer", "Marketing Engineer"],
 *     "description": "Builds outbound and growth systems: enrichment, cold email, CRM automation",
 *     "levels": ["new_grad", "mid"],
 *     "boards": [{ "ats": "ashby", "slug": "clay", "company": "Clay" }]
 *   }
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PATHS } from "../config.js";

export const LEVELS = ["internship", "new_grad", "mid", "senior"] as const;
export type Level = (typeof LEVELS)[number];

const Tier = z.enum(["vancouver", "canada", "remote", "us", "international", "unclear"]);

export const TargetSchema = z.object({
  /** The job titles wanted, as postings write them. At least one. */
  roles: z.array(z.string().min(2)).min(1),
  /** One sentence on what the work is, so JEV can tell a match from a title that only sounds like one. */
  description: z.string().default(""),
  /** Words that make a board title worth reading. Empty: the words of `roles`. */
  titleKeywords: z.array(z.string().min(2)).default([]),
  /** Words that rule a title out before rating (for example "intern", "director"). */
  excludeTitles: z.array(z.string().min(2)).default([]),
  /** Which levels to apply to. Empty means every level. */
  levels: z.array(z.enum(LEVELS)).default([]),
  /** Company boards to poll for these roles, on top of the boards the imported lists point at. */
  boards: z.array(z.object({ ats: z.enum(["greenhouse", "lever", "ashby"]), slug: z.string().min(1), company: z.string().min(1) })).default([]),
  /** Also read the software internship lists and the built-in software boards. Off by default once a target is set. */
  internshipLists: z.boolean().default(false),
  /** How much each kind of location counts, 0 to 1. Missing tiers keep the defaults below. */
  locationWeights: z.record(Tier, z.number().min(0).max(1)).default({}),
});

export type Target = z.infer<typeof TargetSchema>;

export const targetPath = () => PATHS.target;

/** The person's target, or null when there is none (the software-internship default). A file that does not parse is an error, never silently ignored. */
export function loadTarget(file = targetPath()): Target | null {
  if (!existsSync(file)) return null;
  const parsed = TargetSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not a valid target: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP = new Set(["and", "or", "of", "the", "for", "to", "a", "an", "in", "at", "&", "-", "/"]);

/** The words a board title must contain one of. A role of "GTM Engineer" asks for "GTM Engineer" or "GTM". */
export function titleWords(t: Target): string[] {
  if (t.titleKeywords.length) return t.titleKeywords;
  const words = new Set<string>();
  for (const r of t.roles) {
    words.add(r);
    // The first word of a multi-word role is usually the part that sets it apart ("Growth" in "Growth Engineer").
    const first = r.split(/\s+/).find((w) => !STOP.has(w.toLowerCase()));
    if (first && r.includes(" ") && !/^(senior|junior|lead|staff|principal|head|associate)$/i.test(first)) words.add(first);
  }
  return [...words];
}

const wordRegex = (words: string[]) => (words.length ? new RegExp(`(^|[^a-z0-9])(${words.map(escape).join("|")})($|[^a-z0-9])`, "i") : null);

/** True when a board title is worth rating for this target. */
export function titleWanted(title: string, t: Target): boolean {
  const want = wordRegex(titleWords(t));
  const not = wordRegex(t.excludeTitles);
  if (not?.test(title)) return false;
  return want ? want.test(title) : true;
}

/** The reason a title is ruled out before rating, or null. Only the person's own exclusions rule a title out here; JEV judges the role. */
export function titleExcluded(title: string, t: Target): string | null {
  const not = wordRegex(t.excludeTitles);
  const m = not?.exec(title);
  return m ? `title says "${m[2]}"` : null;
}

/** The roles as one line for a question. */
export const rolesLine = (t: Target) => t.roles.join(", ");
