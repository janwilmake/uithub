import { describe, it } from "node:test";
import assert from "node:assert";
import { matchesGlobPatterns } from "../src/parse-zip";

describe("matchesGlobPatterns", () => {
  describe("simple wildcards", () => {
    it("should match * for single segment", () => {
      assert.strictEqual(matchesGlobPatterns("file.ts", ["*.ts"]), true);
      assert.strictEqual(matchesGlobPatterns("file.js", ["*.ts"]), false);
      assert.strictEqual(matchesGlobPatterns("src/file.ts", ["*.ts"]), false);
    });

    it("should match ? for single character", () => {
      assert.strictEqual(matchesGlobPatterns("file1.ts", ["file?.ts"]), true);
      assert.strictEqual(matchesGlobPatterns("file12.ts", ["file?.ts"]), false);
      assert.strictEqual(matchesGlobPatterns("file.ts", ["file?.ts"]), false);
    });
  });

  describe("double star patterns", () => {
    it("should match **/*.ext for any depth", () => {
      assert.strictEqual(matchesGlobPatterns("file.ts", ["**/*.ts"]), true);
      assert.strictEqual(matchesGlobPatterns("src/file.ts", ["**/*.ts"]), true);
      assert.strictEqual(
        matchesGlobPatterns("src/deep/nested/file.ts", ["**/*.ts"]),
        true,
      );
      assert.strictEqual(matchesGlobPatterns("file.js", ["**/*.ts"]), false);
    });

    it("should match **/folder/** for folder at any depth", () => {
      assert.strictEqual(
        matchesGlobPatterns("node_modules/pkg/index.js", ["**/node_modules/**"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("src/node_modules/pkg.js", ["**/node_modules/**"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("src/file.js", ["**/node_modules/**"]),
        false,
      );
    });

    it("should match prefix/**", () => {
      assert.strictEqual(matchesGlobPatterns("src/file.ts", ["src/**"]), true);
      assert.strictEqual(
        matchesGlobPatterns("src/deep/file.ts", ["src/**"]),
        true,
      );
      assert.strictEqual(matchesGlobPatterns("lib/file.ts", ["src/**"]), false);
    });

    it("should match ** at end", () => {
      assert.strictEqual(matchesGlobPatterns("src/file.ts", ["src/**"]), true);
      assert.strictEqual(
        matchesGlobPatterns("src/a/b/c/file.ts", ["src/**"]),
        true,
      );
    });
  });

  describe("character classes", () => {
    it("should match [abc] character class", () => {
      assert.strictEqual(matchesGlobPatterns("file1.ts", ["file[123].ts"]), true);
      assert.strictEqual(matchesGlobPatterns("file4.ts", ["file[123].ts"]), false);
    });

    it("should match [!abc] negated character class", () => {
      assert.strictEqual(matchesGlobPatterns("file4.ts", ["file[!123].ts"]), true);
      assert.strictEqual(matchesGlobPatterns("file1.ts", ["file[!123].ts"]), false);
    });
  });

  describe("brace expansion", () => {
    it("should match {a,b,c} alternatives", () => {
      assert.strictEqual(matchesGlobPatterns("file.ts", ["*.{ts,js}"]), true);
      assert.strictEqual(matchesGlobPatterns("file.js", ["*.{ts,js}"]), true);
      assert.strictEqual(matchesGlobPatterns("file.css", ["*.{ts,js}"]), false);
    });

    it("should match multiple alternatives in paths", () => {
      assert.strictEqual(
        matchesGlobPatterns("src/index.ts", ["{src,lib}/**/*.ts"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("lib/utils.ts", ["{src,lib}/**/*.ts"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("test/file.ts", ["{src,lib}/**/*.ts"]),
        false,
      );
    });
  });

  describe("multiple patterns", () => {
    it("should match if any pattern matches", () => {
      assert.strictEqual(
        matchesGlobPatterns("file.ts", ["*.ts", "*.js"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("file.js", ["*.ts", "*.js"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("file.css", ["*.ts", "*.js"]),
        false,
      );
    });
  });

  describe("path normalization", () => {
    it("should handle leading slash", () => {
      assert.strictEqual(matchesGlobPatterns("/src/file.ts", ["src/**"]), true);
      assert.strictEqual(matchesGlobPatterns("src/file.ts", ["src/**"]), true);
    });

    it("should handle patterns with leading ./", () => {
      assert.strictEqual(matchesGlobPatterns("src/file.ts", ["./src/**"]), true);
    });
  });

  describe("VS Code style patterns", () => {
    it("should match common VS Code exclude patterns", () => {
      // node_modules
      assert.strictEqual(
        matchesGlobPatterns("node_modules/pkg/index.js", ["**/node_modules/**"]),
        true,
      );

      // dist folder
      assert.strictEqual(
        matchesGlobPatterns("dist/bundle.js", ["**/dist/**"]),
        true,
      );

      // test files
      assert.strictEqual(
        matchesGlobPatterns("src/utils.test.ts", ["**/*.test.ts"]),
        true,
      );
      assert.strictEqual(
        matchesGlobPatterns("src/utils.spec.ts", ["**/*.spec.ts"]),
        true,
      );

      // hidden files
      assert.strictEqual(matchesGlobPatterns(".gitignore", [".*"]), true);
      assert.strictEqual(
        matchesGlobPatterns(".github/workflows/ci.yml", [".*/**"]),
        true,
      );
    });
  });
});
