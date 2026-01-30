import { describe, it } from "node:test";
import assert from "node:assert";
import { contentMatchesSearch } from "../src/parse-zip";

describe("contentMatchesSearch", () => {
  const sampleContent = `
function greet(name: string) {
  console.log("Hello, " + name);
  return name.toUpperCase();
}

const message = "Welcome to the app";
export { greet, message };
`;

  describe("basic search", () => {
    it("should return true when no search is provided", () => {
      assert.strictEqual(contentMatchesSearch(sampleContent, {}), true);
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: undefined }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: "" }),
        true,
      );
    });

    it("should find literal strings (case insensitive by default)", () => {
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: "function" }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: "FUNCTION" }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: "Function" }),
        true,
      );
    });

    it("should return false when string not found", () => {
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: "notfound" }),
        false,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, { search: "xyz123" }),
        false,
      );
    });
  });

  describe("case sensitive search", () => {
    it("should match exact case when searchMatchCase is true", () => {
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "function",
          searchMatchCase: true,
        }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "Function",
          searchMatchCase: true,
        }),
        false,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "FUNCTION",
          searchMatchCase: true,
        }),
        false,
      );
    });

    it("should find camelCase identifiers", () => {
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "toUpperCase",
          searchMatchCase: true,
        }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "touppercase",
          searchMatchCase: true,
        }),
        false,
      );
    });
  });

  describe("regular expression search", () => {
    it("should match regex patterns", () => {
      // Match function declarations
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "function\\s+\\w+",
          searchRegularExp: true,
        }),
        true,
      );

      // Match string literals
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: '"[^"]+"',
          searchRegularExp: true,
        }),
        true,
      );

      // Match export statement
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "export\\s*\\{",
          searchRegularExp: true,
        }),
        true,
      );
    });

    it("should be case insensitive by default for regex", () => {
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "FUNCTION\\s+\\w+",
          searchRegularExp: true,
        }),
        true,
      );
    });

    it("should be case sensitive when searchMatchCase is true", () => {
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "function\\s+greet",
          searchRegularExp: true,
          searchMatchCase: true,
        }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "FUNCTION\\s+greet",
          searchRegularExp: true,
          searchMatchCase: true,
        }),
        false,
      );
    });

    it("should handle invalid regex gracefully (fallback to literal)", () => {
      // Invalid regex should be treated as literal string
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "[invalid",
          searchRegularExp: true,
        }),
        false,
      );

      // This literal exists in content
      assert.strictEqual(
        contentMatchesSearch("test [invalid regex", {
          search: "[invalid",
          searchRegularExp: true,
        }),
        true,
      );
    });

    it("should match common search patterns", () => {
      // TODO comments
      const codeWithTodo = "// TODO: fix this\nconst x = 1;";
      assert.strictEqual(
        contentMatchesSearch(codeWithTodo, {
          search: "TODO:",
          searchRegularExp: false,
        }),
        true,
      );

      // Import statements
      const codeWithImport = 'import { foo } from "bar";';
      assert.strictEqual(
        contentMatchesSearch(codeWithImport, {
          search: "import.*from",
          searchRegularExp: true,
        }),
        true,
      );

      // Console.log statements
      assert.strictEqual(
        contentMatchesSearch(sampleContent, {
          search: "console\\.log",
          searchRegularExp: true,
        }),
        true,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty content", () => {
      assert.strictEqual(
        contentMatchesSearch("", { search: "test" }),
        false,
      );
    });

    it("should handle special characters in literal search", () => {
      const content = "const regex = /test\\.js$/;";
      assert.strictEqual(
        contentMatchesSearch(content, { search: "/test" }),
        true,
      );
      assert.strictEqual(
        contentMatchesSearch(content, { search: "\\." }),
        true,
      );
    });

    it("should handle multiline content", () => {
      const multiline = `line1
line2
line3`;
      assert.strictEqual(
        contentMatchesSearch(multiline, { search: "line2" }),
        true,
      );
    });

    it("should handle unicode content", () => {
      const unicode = "const greeting = 'Hello, World!'";
      assert.strictEqual(
        contentMatchesSearch(unicode, { search: "Hello" }),
        true,
      );

      const emoji = "const icon = '🎉';";
      assert.strictEqual(
        contentMatchesSearch(emoji, { search: "icon" }),
        true,
      );
    });
  });
});
