import { describe, expect, it } from "vitest";
import { postedPayRange } from "../src/forms/mapForm.js";

describe("postedPayRange", () => {
  it("reads the range a posting states", () => {
    expect(postedPayRange("Base salary: $140,000 - $180,000 per year")).toEqual({ low: 140000, high: 180000 });
    expect(postedPayRange("The range is $130K to $165K plus equity")).toEqual({ low: 130000, high: 165000 });
    expect(postedPayRange("Pay: $150,000.00 — USD $190,000.00")).toEqual({ low: 150000, high: 190000 });
  });
  it("ignores hourly pay, funding and missing ranges", () => {
    expect(postedPayRange("$25 - $30 an hour")).toBeNull();
    expect(postedPayRange("We raised $40M from top investors")).toBeNull();
    expect(postedPayRange("Competitive salary")).toBeNull();
  });
});
