---
name: uithub-fetcher
description: Fetch GitHub repository contents using uithub CLI when users paste GitHub URLs. Use when users share github.com links or need to analyze repository code, issues, or pull requests.
compatibility: Requires Node.js >=18.0.0 (uses npx uithub-cli)
---

# GitHub Content Fetcher via uithub

## When to use this skill

Activate this skill whenever:
- A user pastes a GitHub URL (github.com/owner/repo)
- A user mentions wanting to see code from a GitHub repository
- A user asks to analyze issues or pull requests from GitHub
- A user needs context from a specific repository

## Prerequisites

Requires Node.js >=18.0.0. No global installation needed — all commands use `npx uithub-cli` which downloads and caches the package automatically.

## How to fetch repository contents

### Basic repository fetch

When a user pastes a GitHub URL like `https://github.com/owner/repo`:

```bash
npx uithub-cli "owner/repo"
```

This returns the full repository structure with file contents.

### Filtering by file extensions

For specific file types (TypeScript, JavaScript, Python, etc.):

```bash
npx uithub-cli "owner/repo?ext=ts,js,py"
```

### Limiting response size

To avoid overwhelming context with large repositories:

```bash
npx uithub-cli "owner/repo?maxTokens=50000"
```

### Fetching specific issues or PRs

For GitHub issues:
```bash
npx uithub-cli "owner/repo/issues/123"
```

For pull requests:
```bash
npx uithub-cli "owner/repo/pull/456"
```

### Searching within repository

To find specific code patterns:
```bash
npx uithub-cli "owner/repo?search=functionName"
```

For case-sensitive regex search:
```bash
npx uithub-cli "owner/repo?search=pattern&searchRegularExp=true&searchMatchCase=true"
```

### Directory filtering

Include specific directories:
```bash
npx uithub-cli "owner/repo?dir=src,lib"
```

Exclude directories:
```bash
npx uithub-cli "owner/repo?exclude-dir=tests,node_modules"
```

### Response formats

Get JSON output:
```bash
npx uithub-cli "owner/repo?accept=application/json"
```

Get YAML:
```bash
npx uithub-cli "owner/repo?accept=text/yaml"
```

Get HTML:
```bash
npx uithub-cli "owner/repo?accept=text/html"
```

## Authentication flow

On first use, the CLI will:
1. Open a browser for GitHub OAuth authentication
2. Store the access token locally in `~/.uithub/token.json`
3. Automatically use the token for subsequent requests

The token expires after a set period and will automatically re-authenticate when needed.

To manually logout:
```bash
npx uithub-cli logout
```

## Common usage patterns

### Pattern 1: User shares GitHub URL for analysis

**User says**: "Can you look at https://github.com/facebook/react?"

**Steps**:
1. Extract owner/repo from URL: `facebook/react`
2. Assess repository size - React is large, so limit tokens
3. Fetch with constraints:
   ```bash
   npx uithub-cli "facebook/react?ext=js,ts&maxTokens=30000&dir=packages/react/src"
   ```

### Pattern 2: User wants to understand a specific issue

**User says**: "What's happening in https://github.com/nodejs/node/issues/12345?"

**Steps**:
1. Parse issue URL
2. Fetch issue content:
   ```bash
   npx uithub-cli "nodejs/node/issues/12345"
   ```

### Pattern 3: User needs code examples

**User says**: "Show me how authentication works in that Express.js repo"

**Steps**:
1. Search for authentication-related code:
   ```bash
   npx uithub-cli "expressjs/express?search=auth&ext=js&dir=lib"
   ```

### Pattern 4: Large repository with specific focus

**User says**: "I need to see the TypeScript types from https://github.com/microsoft/TypeScript"

**Steps**:
1. Filter for TypeScript definition files only:
   ```bash
   npx uithub-cli "microsoft/TypeScript?ext=d.ts&maxTokens=40000"
   ```

## Query parameters reference

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `ext` | Include file extensions | `ext=ts,js,md` |
| `exclude-ext` | Exclude file extensions | `exclude-ext=test.ts` |
| `dir` | Include directories | `dir=src,lib` |
| `exclude-dir` | Exclude directories | `exclude-dir=node_modules,dist` |
| `maxFileSize` | Max file size in bytes | `maxFileSize=100000` |
| `maxTokens` | Max LLM tokens | `maxTokens=50000` |
| `accept` | Response format | `accept=application/json` |
| `include` | Glob patterns to include | `include=**/*.ts,src/**` |
| `exclude` | Glob patterns to exclude | `exclude=**/*.test.ts` |
| `search` | Search file contents | `search=functionName` |
| `searchMatchCase` | Case-sensitive search | `searchMatchCase=true` |
| `searchRegularExp` | Use regex | `searchRegularExp=true` |
| `omitFiles` | Omit file contents | `omitFiles=true` |
| `omitTree` | Omit directory tree | `omitTree=true` |
| `lines` | Show line numbers | `lines=false` to disable |
| `disableGenignore` | Disable .genignore | `disableGenignore=true` |

## Error handling

### Token expired or invalid
If you see a 401 error, the CLI will automatically re-authenticate. Let the user know:
"The GitHub authentication token has expired. Please authorize in the browser that just opened."

### Repository too large
If the response is truncated or times out:
1. Use `maxTokens` to limit size
2. Focus on specific directories with `dir`
3. Filter by file extensions with `ext`

### Rate limiting
If rate limited, inform the user and wait before retrying.

## Best practices

1. **Always assess repository size first**: Large repos need filtering
2. **Use directory filtering**: Focus on relevant code paths (src, lib, etc.)
3. **Limit file types**: Don't fetch images, build artifacts, or test files unless needed
4. **Set reasonable token limits**: Start with 30,000-50,000 tokens for safety
5. **Check authentication status**: If the user hasn't authenticated yet, explain the OAuth flow
6. **Parse URLs carefully**: Extract owner/repo/resource from various GitHub URL formats

## Examples

See [EXAMPLES.md](references/EXAMPLES.md) for detailed usage scenarios.