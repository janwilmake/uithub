# Detailed Usage Examples

## Example 1: Analyzing a small utility library

User pastes: `https://github.com/sindresorhus/got`

```bash
# Fetch the full repository (it's small)
npx uithub-cli "sindresorhus/got?ext=ts,js,md"
```

**Expected output**: Complete repository structure with TypeScript/JavaScript source and documentation.

## Example 2: Large framework - focused exploration

User wants to understand Next.js routing:

```bash
# Focus on the router package only
npx uithub-cli "vercel/next.js?dir=packages/next/src/client/components&ext=ts,tsx&maxTokens=40000"
```

## Example 3: Finding specific functionality

User asks: "How does Vite handle CSS imports?"

```bash
# Search for CSS-related code
npx uithub-cli "vitejs/vite?search=css&ext=ts&dir=packages/vite/src"
```

## Example 4: Issue investigation

User shares: `https://github.com/microsoft/vscode/issues/167890`

```bash
# Fetch the specific issue with comments
npx uithub-cli "microsoft/vscode/issues/167890"
```

## Example 5: Pull request review

User wants to see a PR: `https://github.com/facebook/react/pull/25683`

```bash
# Get PR details and diff
npx uithub-cli "facebook/react/pull/25683"
```

## Example 6: Configuration files only

User needs to see build configuration:

```bash
# Fetch only config files
npx uithub-cli "owner/repo?include=**/*.config.js,**/*.config.ts,**/tsconfig.json"
```

## Example 7: Excluding test files

User wants production code only:

```bash
# Exclude test and spec files
npx uithub-cli "owner/repo?exclude=**/*.test.*,**/*.spec.*,**/tests/**&maxTokens=50000"
```

## Example 8: Tree structure only

User wants to see project organization without file contents:

```bash
# Get directory tree only
npx uithub-cli "owner/repo?omitFiles=true"
```

## Example 9: JSON output for programmatic use

When you need structured data:

```bash
# Get JSON format
npx uithub-cli "owner/repo?accept=application/json&ext=ts&maxTokens=30000"
```

## Example 10: Multiple GitHub URL formats

The skill should handle all these formats:

- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/main/src`
- `github.com/owner/repo`
- `owner/repo`
- `https://github.com/owner/repo/issues/123`
- `https://github.com/owner/repo/pull/456`

Extract the relevant parts and construct the appropriate uithub command.