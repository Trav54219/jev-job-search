import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resumeFor } from "../src/forms/mapForm.js";
import { ProfileSchema } from "../src/profile/schema.js";

const base = ProfileSchema.parse(JSON.parse(readFileSync("data/profile.example.json", "utf8")));
const profile = {
  ...base,
  resume: {
    ...base.resume,
    variants: [
      { name: "Lifecycle", titles: "lifecycle|email", path: "/r/lifecycle.pdf" },
      { name: "RevOps", titles: "revenue op|revops|marketing op", path: "/r/revops.pdf" },
      { name: "Broken", titles: "(", path: "/r/broken.pdf" },
    ],
  },
};

describe("resume versions", () => {
  it("picks the first version whose pattern matches the title", () => {
    expect(resumeFor(profile, "Email Marketing Manager")).toBe("/r/lifecycle.pdf");
    expect(resumeFor(profile, "Revenue Operations Manager")).toBe("/r/revops.pdf");
  });
  it("falls back to the main resume, and skips a broken pattern", () => {
    expect(resumeFor(profile, "GTM Engineer")).toBe(base.resume.path);
  });
  it("uses the main resume when the profile has no versions", () => {
    expect(resumeFor(base, "Email Marketing Manager")).toBe(base.resume.path);
  });
});
