# uithub-lib

Parse GitHub repository zip files and format them for LLM consumption. Optimizes repository content with token counting, file filtering, and tree visualization.

## Installation

```bash
npm install uithub-lib
```

## Quick Start

```typescript
import { parseGitHubZip } from "uithub-lib";

// Fetch a GitHub repository as a zip stream
const response = await fetch(
  "https://github.com/owner/repo/archive/refs/heads/main.zip",
);

const result = await parseGitHubZip(response.body, "owner", "repo", "main", {
  maxTokens: 50000,
});

console.log(result.fileString); // Formatted content ready for LLMs
console.log(result.totalTokens); // Total token count
```

## API

### `parseGitHubZip(zipStream, owner, repo, branch?, options?)`

Main function to parse and format a GitHub repository.

**Parameters:**

| Parameter   | Type                         | Description                      |
| ----------- | ---------------------------- | -------------------------------- |
| `zipStream` | `ReadableStream<Uint8Array>` | The zip file stream              |
| `owner`     | `string`                     | Repository owner                 |
| `repo`      | `string`                     | Repository name                  |
| `branch`    | `string` (optional)          | Branch name (defaults to "HEAD") |
| `options`   | `UithubOptions` (optional)   | Parsing and formatting options   |

**Returns:** `Promise<UithubResult>`

### Options

```typescript
interface UithubOptions {
  // Token limit (required)
  maxTokens: number; // Maximum tokens to include

  // File filtering
  includeExt?: string[]; // Only include files with these extensions
  excludeExt?: string[]; // Exclude files with these extensions
  includeDir?: string[]; // Only include files in these directories
  excludeDir?: string[]; // Exclude files in these directories
  paths?: string[]; // Only include files under these paths
  maxFileSize?: number; // Skip files larger than this (bytes)

  // Glob patterns (VS Code style)
  include?: string[]; // Glob patterns for files to include
  exclude?: string[]; // Glob patterns for files to exclude

  // Content search
  search?: string; // Search string to filter files by content
  searchMatchCase?: boolean; // Case-sensitive search (default: false)
  searchRegularExp?: boolean; // Treat search as regex (default: false)

  // Special filters
  yamlFilter?: string; // YAML structure to filter files
  disableGenignore?: boolean; // Disable .genignore processing

  // Formatting
  shouldAddLineNumbers?: boolean; // Add line numbers (default: true)
  shouldOmitFiles?: boolean; // Omit file contents, only return tree
  shouldOmitTree?: boolean; // Omit tree from output
}
```

### Result

```typescript
interface UithubResult {
  files: { [path: string]: ContentType }; // Parsed file contents
  tree: NestedObject<null>; // Directory tree structure
  tokenTree: TokenTree; // Tree with token counts
  fileString: string; // Formatted string for LLMs
  tokens: number; // Tokens in fileString
  totalTokens: number; // Total tokens processed
  totalLines: number; // Total lines processed
}
```

## File Filtering

### By Extension

```typescript
// Only TypeScript files
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  includeExt: ["ts", "tsx"],
});

// Exclude test files
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  excludeExt: ["test.ts", "spec.ts"],
});
```

### By Directory

```typescript
// Only src folder
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  includeDir: ["src"],
});

// Exclude node_modules and build
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  excludeDir: ["node_modules", "build", "dist"],
});
```

### By Path

```typescript
// Only specific paths
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  paths: ["src/components", "src/utils"],
});
```

### Glob Patterns (VS Code Style)

Use `include` and `exclude` for powerful glob pattern matching, similar to VS Code's file search:

```typescript
// Only TypeScript files in src
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  include: ["src/**/*.ts", "src/**/*.tsx"],
});

// Exclude test files and node_modules
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
});

// Combine include and exclude
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  include: ["src/**"],
  exclude: ["**/*.test.ts"],
});
```

**Supported glob syntax:**

| Pattern   | Description                                           |
| --------- | ----------------------------------------------------- |
| `*`       | Matches any characters except `/`                     |
| `**`      | Matches any characters including `/` (any path depth) |
| `?`       | Matches any single character except `/`               |
| `[abc]`   | Matches any character in brackets                     |
| `[!abc]`  | Matches any character not in brackets                 |
| `{a,b,c}` | Matches any of the alternatives                       |

**Examples:**

| Pattern         | Matches                              |
| --------------- | ------------------------------------ |
| `*.ts`          | `index.ts`, `utils.ts` (root only)   |
| `**/*.ts`       | All `.ts` files at any depth         |
| `src/**`        | Everything in `src/` directory       |
| `**/test/**`    | Any file under any `test/` directory |
| `*.{ts,tsx}`    | Files ending in `.ts` or `.tsx`      |
| `src/[abc]*.ts` | `src/a.ts`, `src/b.ts`, `src/c.ts`   |

## Content Search

Filter files by their content using the `search` option:

```typescript
// Find files containing "TODO"
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  search: "TODO",
});

// Case-sensitive search
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  search: "MyClass",
  searchMatchCase: true,
});

// Regular expression search
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  search: "function\\s+\\w+",
  searchRegularExp: true,
});

// Find React components with useState
await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 50000,
  include: ["**/*.tsx"],
  search: "useState",
});
```

**Search options:**

| Option             | Type      | Default | Description                                 |
| ------------------ | --------- | ------- | ------------------------------------------- |
| `search`           | `string`  | -       | Search string or regex pattern              |
| `searchMatchCase`  | `boolean` | `false` | Enable case-sensitive matching              |
| `searchRegularExp` | `boolean` | `false` | Treat search string as a regular expression |

## .genignore Support

The library automatically respects `.genignore` files in repositories. This works like `.gitignore` but is specifically for controlling what content is exposed to LLMs/AI tools.

Default patterns (when no `.genignore` exists):

```
package-lock.json
build
node_modules
```

Disable with `disableGenignore: true`.

## Token Management

Files are sorted by token count (smallest first) and included until `maxTokens` is reached. This ensures maximum file coverage within your token budget.

```typescript
const result = await parseGitHubZip(stream, owner, repo, branch, {
  maxTokens: 100000,
});

console.log(`Used ${result.tokens} of ${result.totalTokens} available tokens`);
```

## Output Format

The `fileString` output is formatted for optimal LLM consumption:

```
├── src/ (1500 tokens)
│   ├── index.ts (500 tokens)
│   └── utils.ts (1000 tokens)
└── package.json (200 tokens)


/src/index.ts:
--------------------------------------------------------------------------------
 1 | import { foo } from "./utils";
 2 |
 3 | export function main() {
 4 |   return foo();
 5 | }


--------------------------------------------------------------------------------

/src/utils.ts:
--------------------------------------------------------------------------------
 1 | export function foo() {
 2 |   return "bar";
 3 | }


--------------------------------------------------------------------------------
```

## Exported Utilities

```typescript
import {
  // Main function
  parseGitHubZip,

  // Parsing utilities
  parseZipStreaming,
  addLineNumbers,
  calculateFileTokens,
  matchesGlobPatterns, // Check if path matches glob patterns
  contentMatchesSearch, // Check if content matches search criteria

  // Formatting utilities
  formatRepoContent,
  filePathToNestedObject,
  filePathToTokenTree,
  tokenTreeToString,

  // Types
  type UithubResult,
  type ContentType,
  type FormatOptions,
  type ParseOptions,
  type NestedObject,
  type TokenTree,
  type StreamingParseContext,
  type SearchOptions, // Options for content search

  // Constants
  CHARACTERS_PER_TOKEN, // Default: 5
} from "uithub-lib";
```

## Binary Files

Binary files are not included as content. Instead, a URL to the raw file is provided:

```typescript
// Binary file in result.files
{
  "/images/logo.png": {
    type: "binary",
    url: "https://raw.githubusercontent.com/owner/repo/main/images/logo.png",
    hash: "abc123...",
    size: 12345
  }
}
```

## License

MIT
