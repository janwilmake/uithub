# GitHub URL Parsing Reference

## URL pattern matching

The skill must recognize and parse these GitHub URL patterns:

### Repository URLs

```
https://github.com/owner/repo
https://github.com/owner/repo.git
github.com/owner/repo
owner/repo
```

**Extract**: `owner`, `repo`
**Command**: `npx uithub-cli "owner/repo[?params]"`

### Branch/tree URLs

```
https://github.com/owner/repo/tree/branch-name
https://github.com/owner/repo/tree/main/src/components
```

**Extract**: `owner`, `repo`, optional `path`
**Command**: `npx uithub-cli "owner/repo?dir=src/components"`

### Issue URLs

```
https://github.com/owner/repo/issues/123
github.com/owner/repo/issues/123
```

**Extract**: `owner`, `repo`, `issue_number`
**Command**: `npx uithub-cli "owner/repo/issues/123"`

### Pull request URLs

```
https://github.com/owner/repo/pull/456
https://github.com/owner/repo/pull/456/files
```

**Extract**: `owner`, `repo`, `pr_number`
**Command**: `npx uithub-cli "owner/repo/pull/456"`

### File URLs

```
https://github.com/owner/repo/blob/main/src/index.ts
https://github.com/owner/repo/blob/main/README.md
```

**Extract**: `owner`, `repo`, `file_path`
**Strategy**: Fetch the specific file or directory containing it

## Parsing logic

```javascript
function parseGitHubURL(url) {
  // Remove protocol and www
  let cleaned = url.replace(/^https?:\/\/(www\.)?/, '');
  
  // Remove .git suffix
  cleaned = cleaned.replace(/\.git$/, '');
  
  // Remove github.com prefix if present
  cleaned = cleaned.replace(/^github\.com\//, '');
  
  // Split into parts
  const parts = cleaned.split('/');
  
  if (parts.length < 2) {
    throw new Error('Invalid GitHub URL: missing owner or repo');
  }
  
  const owner = parts[0];
  const repo = parts[1];
  const type = parts[2]; // 'issues', 'pull', 'tree', 'blob', etc.
  const identifier = parts[3]; // issue number, branch name, etc.
  
  return { owner, repo, type, identifier, remainingPath: parts.slice(4) };
}
```

## Command construction examples

### Example 1: Basic repo URL
Input: `https://github.com/facebook/react`
Output: `npx uithub-cli "facebook/react"`

### Example 2: Specific directory
Input: `https://github.com/facebook/react/tree/main/packages/react`
Output: `npx uithub-cli "facebook/react?dir=packages/react"`

### Example 3: Issue
Input: `https://github.com/nodejs/node/issues/12345`
Output: `npx uithub-cli "nodejs/node/issues/12345"`

### Example 4: Pull request
Input: `https://github.com/microsoft/TypeScript/pull/54321`
Output: `npx uithub-cli "microsoft/TypeScript/pull/54321"`

### Example 5: Specific file
Input: `https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/request.ts`
Strategy: Fetch the directory or use search to find the file
Output: `npx uithub-cli "vercel/next.js?include=**/request.ts&dir=packages/next/src/server/web/spec-extension"`