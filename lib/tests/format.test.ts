import { describe, it } from "node:test";
import assert from "node:assert";
import {
  filePathToNestedObject,
  filePathToTokenTree,
  tokenTreeToString,
  formatRepoContent,
} from "../src/format";
import type { ContentType } from "../src/types";

describe("filePathToNestedObject", () => {
  it("should convert flat paths to nested object", () => {
    const flat = {
      "/src/index.ts": "content1",
      "/src/utils/helper.ts": "content2",
      "/README.md": "content3",
    };

    const result = filePathToNestedObject(flat, (v) => v);

    assert.deepStrictEqual(result, {
      src: {
        "index.ts": "content1",
        utils: {
          "helper.ts": "content2",
        },
      },
      "README.md": "content3",
    });
  });

  it("should handle paths without leading slash", () => {
    const flat = {
      "src/file.ts": "content",
    };

    const result = filePathToNestedObject(flat, (v) => v);

    assert.deepStrictEqual(result, {
      src: {
        "file.ts": "content",
      },
    });
  });

  it("should apply mapper function", () => {
    const flat = {
      "/file.ts": { data: "test" },
    };

    const result = filePathToNestedObject(flat, () => null);

    assert.deepStrictEqual(result, {
      "file.ts": null,
    });
  });
});

describe("filePathToTokenTree", () => {
  it("should calculate token counts for files", () => {
    const files: { [path: string]: ContentType } = {
      "/src/index.ts": {
        type: "content",
        content: "const x = 1;",
        hash: "abc",
        size: 12,
      },
    };

    const result = filePathToTokenTree(files, false);

    assert.strictEqual(typeof result.src, "object");
    assert.strictEqual(typeof (result.src as any)["index.ts"], "number");
    assert.ok((result.src as any)["index.ts"] > 0);
  });
});

describe("tokenTreeToString", () => {
  it("should format token tree as string", () => {
    const tree = {
      src: {
        "index.ts": 500,
        "utils.ts": 200,
      },
      "README.md": 100,
    };

    const result = tokenTreeToString(tree);

    assert.ok(result.includes("src/"));
    assert.ok(result.includes("index.ts"));
    assert.ok(result.includes("utils.ts"));
    assert.ok(result.includes("README.md"));
    assert.ok(result.includes("tokens"));
  });

  it("should use tree characters", () => {
    const tree = {
      a: 100,
      b: 200,
    };

    const result = tokenTreeToString(tree);

    assert.ok(result.includes("├──") || result.includes("└──"));
  });
});

describe("formatRepoContent", () => {
  it("should format repository content", () => {
    const files: { [path: string]: ContentType } = {
      "/src/index.ts": {
        type: "content",
        content: 'console.log("hello");',
        hash: "abc123",
        size: 21,
      },
      "/README.md": {
        type: "content",
        content: "# Test",
        hash: "def456",
        size: 6,
      },
    };

    const result = formatRepoContent(files, {
      shouldAddLineNumbers: true,
      shouldOmitFiles: false,
      shouldOmitTree: false,
    });

    assert.ok(result.tree);
    assert.ok(result.tokenTree);
    assert.ok(result.fileString);
    assert.ok(result.tokens > 0);
    assert.ok(result.treeTokens > 0);
  });

  it("should omit files when shouldOmitFiles is true", () => {
    const files: { [path: string]: ContentType } = {
      "/test.ts": {
        type: "content",
        content: "const x = 1;",
        hash: "abc",
        size: 12,
      },
    };

    const withFiles = formatRepoContent(files, {
      shouldAddLineNumbers: false,
      shouldOmitFiles: false,
      shouldOmitTree: false,
    });

    const withoutFiles = formatRepoContent(files, {
      shouldAddLineNumbers: false,
      shouldOmitFiles: true,
      shouldOmitTree: false,
    });

    assert.ok(withFiles.fileString.includes("const x = 1;"));
    assert.ok(!withoutFiles.fileString.includes("const x = 1;"));
  });

  it("should handle binary files", () => {
    const files: { [path: string]: ContentType } = {
      "/image.png": {
        type: "binary",
        url: "https://example.com/image.png",
        hash: "abc",
        size: 1000,
      },
    };

    const result = formatRepoContent(files, {
      shouldAddLineNumbers: false,
      shouldOmitFiles: false,
      shouldOmitTree: false,
    });

    assert.ok(result.fileString.includes("https://example.com/image.png"));
  });
});
