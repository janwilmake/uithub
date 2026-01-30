import { describe, it } from "node:test";
import assert from "node:assert";
import { addLineNumbers, calculateFileTokens } from "../src/parse-zip";

describe("addLineNumbers", () => {
  it("should add line numbers when enabled", () => {
    const content = "line1\nline2\nline3";
    const result = addLineNumbers(content, true);

    assert.ok(result.includes("1 |"));
    assert.ok(result.includes("2 |"));
    assert.ok(result.includes("3 |"));
    assert.ok(result.includes("line1"));
    assert.ok(result.includes("line2"));
    assert.ok(result.includes("line3"));
  });

  it("should not add line numbers when disabled", () => {
    const content = "line1\nline2";
    const result = addLineNumbers(content, false);

    assert.strictEqual(result, content);
  });

  it("should pad line numbers for alignment", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const result = addLineNumbers(content, true);

    // Line 1 should have padding (spaces before 1)
    assert.ok(result.includes("  1 |"));
    // Line 100 should not have padding
    assert.ok(result.includes("100 |"));
  });

  it("should handle empty content", () => {
    const result = addLineNumbers("", true);
    assert.strictEqual(result, "1 | ");
  });

  it("should handle single line", () => {
    const result = addLineNumbers("single line", true);
    assert.strictEqual(result, "1 | single line");
  });
});

describe("calculateFileTokens", () => {
  it("should calculate tokens for file content", () => {
    const path = "/test.ts";
    const content = "const x = 1;";
    const tokens = calculateFileTokens(path, content, false);

    assert.ok(tokens > 0);
    assert.strictEqual(typeof tokens, "number");
  });

  it("should return more tokens with line numbers", () => {
    const path = "/test.ts";
    const content = "line1\nline2\nline3";

    const tokensWithoutNumbers = calculateFileTokens(path, content, false);
    const tokensWithNumbers = calculateFileTokens(path, content, true);

    assert.ok(tokensWithNumbers > tokensWithoutNumbers);
  });

  it("should include path in token calculation", () => {
    const shortPath = "/a.ts";
    const longPath = "/very/long/nested/path/to/file.ts";
    const content = "x";

    const shortTokens = calculateFileTokens(shortPath, content, false);
    const longTokens = calculateFileTokens(longPath, content, false);

    assert.ok(longTokens > shortTokens);
  });
});
