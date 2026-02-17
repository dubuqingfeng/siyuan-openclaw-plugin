import { describe, it, expect } from "vitest";
import {
  buildSectionEntriesFromMarkdown,
  sanitizeKramdown,
} from "../../src/services/index-sync.js";

describe("section indexing (kramdown/markdown)", () => {
  it("should build sections by H2", () => {
    const md = [
      "# Doc Title",
      "Intro line",
      "",
      "## Section A",
      "A1",
      "A2",
      "",
      "## Section B",
      "B1",
      "",
    ].join("\n");

    const cfg = {
      index: { sectionHeadingLevels: [2], maxSectionsToIndex: 80, sectionMaxChars: 2000 },
    };

    const sections = buildSectionEntriesFromMarkdown(md, cfg, "d1");
    expect(sections).toHaveLength(2);

    expect(sections[0].id.startsWith("d1::h2::")).toBe(true);
    expect(sections[0].content).toContain("## Section A");
    expect(sections[0].content).toContain("A1");
    expect(sections[0].content).not.toContain("Intro line");

    expect(sections[1].id.startsWith("d1::h2::")).toBe(true);
    expect(sections[1].content).toContain("## Section B");
    expect(sections[1].content).toContain("B1");
  });

  it("should support heading level config with strings", () => {
    const md = ["# Doc Title", "Intro line", "More"].join("\n");
    const cfg = { index: { sectionHeadingLevels: ["h1"] } };

    const sections = buildSectionEntriesFromMarkdown(md, cfg, "d1");
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain("# Doc Title");
    expect(sections[0].content).toContain("Intro line");
  });

  it("should allow disabling section splitting", () => {
    const md = ["# Doc Title", "Intro line"].join("\n");
    const cfg = { index: { sectionHeadingLevels: [] } };
    const sections = buildSectionEntriesFromMarkdown(md, cfg, "d1");
    expect(sections).toEqual([]);
  });

  it("should deduplicate list lines with and without numbering", () => {
    const md = [
      "## S",
      "1. Same",
      "Same",
      "2. Other",
      "Other",
    ].join("\n");
    const cfg = { index: { sectionHeadingLevels: [2], sectionDedupLines: true } };

    const sections = buildSectionEntriesFromMarkdown(md, cfg, "d1");
    expect(sections).toHaveLength(1);

    const content = sections[0].content;
    expect(content).toContain("1. Same");
    expect(content).toContain("2. Other");
    expect(content.split("Same").length).toBe(2);
    expect(content.split("Other").length).toBe(2);
  });

  it("should remove kramdown attribute lines and inline attribute blobs", () => {
    const raw = [
      "## Title",
      "{: id=\"202602\"}",
      "1. Item {: id=\"x\"}",
    ].join("\n");
    const sanitized = sanitizeKramdown(raw);
    expect(sanitized).toContain("## Title");
    expect(sanitized).not.toContain("{:");
    expect(sanitized).toContain("1. Item");
  });
});

