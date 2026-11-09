import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preFilter } from "../src/jobs/hardFilters.js";
import type { Job } from "../src/jobs/normalize.js";
import { fitQuestions, scoreFromAnswers } from "../src/jobs/rate.js";
import { loadTarget, TargetSchema, titleExcluded, titleWanted, titleWords } from "../src/jobs/target.js";
import type { Answer } from "../src/jev/types.js";
import { ProfileSchema } from "../src/profile/schema.js";
import { readFileSync } from "node:fs";

const now = new Date("2026-10-02T12:00:00Z");
const job = (over: Partial<Job> = {}): Job => ({
  id: "j", source: "t", company: "Acme", title: "GTM Engineer", url: "https://jobs.ashbyhq.com/acme/1", ats: "ashby",
  locations: ["New York, NY"], postedAt: "2026-10-01", terms: [], sponsorship: "unknown", degrees: [], category: null, ...over,
});
const gtm = TargetSchema.parse({ roles: ["GTM Engineer", "Growth Engineer", "Marketing Engineer"], levels: ["new_grad", "mid"], excludeTitles: ["intern", "director"] });

function answers(over: Record<string, Partial<Answer>> = {}): Record<string, Answer> {
  const base: Record<string, Answer> = {
    is_target_role: { type: "noul", noul: 0.95 },
    level: { type: "choice", choice: "mid", probabilities: { mid: 1 }, confidence: 1 },
    is_unpaid: { type: "noul", noul: 0.02 },
    needs_advanced_degree: { type: "noul", noul: 0.02 },
    work_auth: { type: "choice", choice: "us_no_sponsorship", probabilities: {}, confidence: 1 },
    stack_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    experience_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    location_tier: { type: "choice", choice: "us", probabilities: {}, confidence: 1 },
    interview_practical: { type: "noul", noul: 0.3 },
    callback_likelihood: { type: "score", score: 3, legend: { "3": "Likely" }, probabilities: {}, confidence: 0.7 },
    needs_account: { type: "noul", noul: 0.1 },
    requires_references: { type: "noul", noul: 0.05 },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v } as Answer;
  return base;
}
const citizen = { authorized: true, citizen: true };

describe("target titles", () => {
  it("takes the roles and their first words as board keywords", () => {
    expect(titleWords(gtm)).toEqual(expect.arrayContaining(["GTM Engineer", "GTM", "Growth", "Marketing"]));
    expect(titleWords(TargetSchema.parse({ roles: ["Senior Account Executive"] }))).toEqual(["Senior Account Executive"]);
    expect(titleWords(TargetSchema.parse({ roles: ["RevOps"], titleKeywords: ["Revenue Operations"] }))).toEqual(["Revenue Operations"]);
  });
  it("wants a board title that names a role, and never one the person excluded", () => {
    expect(titleWanted("GTM Engineer, Outbound", gtm)).toBe(true);
    expect(titleWanted("Growth Marketing Engineer", gtm)).toBe(true);
    expect(titleWanted("Senior Backend Engineer", gtm)).toBe(false);
    expect(titleWanted("GTM Engineering Intern", gtm)).toBe(false);
    expect(titleWanted("Director of Growth", gtm)).toBe(false);
  });
  it("matches whole words only", () => {
    expect(titleExcluded("International Sales Lead", gtm)).toBeNull();
    expect(titleExcluded("Growth Intern", gtm)).toMatch(/intern/i);
  });
});

describe("preFilter with a target", () => {
  it("lets sales and marketing titles through that the software filter drops", () => {
    expect(preFilter(job({ title: "Marketing Engineer" }), now)).toMatch(/not a software role/);
    expect(preFilter(job({ title: "Marketing Engineer" }), now, () => false, citizen, 14, () => false, gtm)).toBeNull();
    expect(preFilter(job({ title: "Sales Engineer" }), now, () => false, citizen, 14, () => false, gtm)).toBeNull();
  });
  it("still applies the person's exclusions and every other rule", () => {
    expect(preFilter(job({ title: "Growth Intern" }), now, () => false, citizen, 14, () => false, gtm)).toMatch(/intern/i);
    expect(preFilter(job({ ats: "icims" }), now, () => false, citizen, 14, () => false, gtm)).toMatch(/account/);
    expect(preFilter(job({ postedAt: "2026-09-01" }), now, () => false, citizen, 14, () => false, gtm)).toMatch(/days ago/);
  });
});

describe("rating with a target", () => {
  const profile = ProfileSchema.parse(JSON.parse(readFileSync(path.join(__dirname, "..", "data", "profile.example.json"), "utf8")));
  it("asks about the person's roles, not software or internship terms", () => {
    const q = fitQuestions(profile, gtm);
    expect(Object.keys(q)).toContain("is_target_role");
    expect(Object.keys(q)).not.toContain("is_software_role");
    expect(Object.keys(q)).not.toContain("term");
    expect(Object.keys(q)).not.toContain("graduation_excluded");
    expect(JSON.stringify(q.is_target_role)).toContain("GTM Engineer, Growth Engineer, Marketing Engineer");
  });
  it("keeps the default questions with no target", () => {
    expect(Object.keys(fitQuestions(profile, null))).toContain("is_software_role");
  });
  it("applies to a mid-level GTM role a citizen can take", () => {
    const fit = scoreFromAnswers(job(), answers(), now, citizen, gtm);
    expect(fit.skipReason).toBeNull();
    expect(fit.decision).toBe("apply");
    expect(fit.components.levelFit).toBe(1);
    expect(fit.components.termFit).toBe(1);
  });
  it("skips a posting that is not one of the roles, or at a level not wanted", () => {
    expect(scoreFromAnswers(job(), answers({ is_target_role: { noul: 0.1 } }), now, citizen, gtm).skipReason).toMatch(/not one of: GTM Engineer/);
    expect(scoreFromAnswers(job(), answers({ level: { choice: "senior", confidence: 0.9 } }), now, citizen, gtm).skipReason).toMatch(/senior level, wanted new_grad or mid/);
    // A level JEV is unsure of does not skip; it ranks lower.
    const unsure = scoreFromAnswers(job(), answers({ level: { choice: "senior", confidence: 0.4 } }), now, citizen, gtm);
    expect(unsure.skipReason).toBeNull();
    expect(unsure.components.levelFit).toBeLessThan(1);
  });
  it("takes every level when the target names none", () => {
    const any = TargetSchema.parse({ roles: ["Account Executive"] });
    expect(scoreFromAnswers(job(), answers({ level: { choice: "senior", confidence: 1 } }), now, citizen, any).skipReason).toBeNull();
  });
  it("weighs US and remote the same unless the target says otherwise", () => {
    const us = scoreFromAnswers(job(), answers(), now, citizen, gtm).score;
    const remote = scoreFromAnswers(job({ locations: ["Remote"] }), answers({ location_tier: { choice: "remote" } }), now, citizen, gtm).score;
    expect(us).toBe(remote);
    const remoteFirst = TargetSchema.parse({ ...gtm, locationWeights: { us: 0.5 } });
    expect(scoreFromAnswers(job(), answers(), now, citizen, remoteFirst).score).toBeLessThan(us);
  });
  it("still skips on work authorization", () => {
    expect(scoreFromAnswers(job(), answers(), now, { authorized: false, citizen: false }, gtm).skipReason).toMatch(/no sponsorship/);
  });
});

describe("loadTarget", () => {
  it("is null without a file and refuses a broken one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "target-"));
    expect(loadTarget(path.join(dir, "none.json"))).toBeNull();
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ roles: [] }));
    expect(() => loadTarget(bad)).toThrow(/not a valid target/);
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ roles: ["GTM Engineer"] }));
    expect(loadTarget(good)?.roles).toEqual(["GTM Engineer"]);
  });
});

describe("yearsOfExperience", () => {
  it("counts months held in two roles at once one time", async () => {
    const { yearsOfExperience } = await import("../src/profile/fieldKeys.js");
    const p = (experience: { start: string; end: string; current?: boolean }[]) =>
      ({ experience: experience.map((e) => ({ company: "A", title: "T", location: "", bullets: [], current: false, ...e })) }) as never;
    expect(yearsOfExperience(p([{ start: "2022-01", end: "2024-01" }, { start: "2023-01", end: "2024-01" }]))).toBe(2);
    expect(yearsOfExperience(p([{ start: "2020-01", end: "2021-01" }, { start: "2022-01", end: "2023-07" }]))).toBe(2);
  });
});

describe("excluded employers", () => {
  it("skips an employer the person is already in process with, by list and by single link", async () => {
    const { companyExcluded } = await import("../src/jobs/target.js");
    const t = TargetSchema.parse({ roles: ["GTM Engineer"], excludeCompanies: ["Equi", "Vega"] });
    expect(companyExcluded("Equi", t)).toMatch(/Equi/);
    expect(companyExcluded("Equinix", t)).toBeNull();
    expect(companyExcluded("Vega Claims", t)).toMatch(/Vega/);
    expect(preFilter(job({ company: "Equi" }), now, () => false, citizen, 14, () => false, t)).toMatch(/already in process/);
    expect(scoreFromAnswers(job({ company: "Vega" }), answers(), now, citizen, t).skipReason).toMatch(/already in process/);
  });
});
