# uithub

[![Chat with Repo](https://badge.forgithub.com/janwilmake/uithub?badge=chat)](https://uithub.com/janwilmake/uithub)

Turn any GitHub repository into LLM-ready context. Just replace `github.com` with `uithub.com` in any URL.

```
https://github.com/facebook/react  →  https://uithub.com/facebook/react
```

uithub streams the repository ZIP, parses it on the fly, and returns a token-counted, tree-structured view of the codebase — ready to paste into ChatGPT, Claude, or any other LLM.

## Features

- **Streaming ZIP parsing** — fetches and parses repos on the edge via Cloudflare Workers, no full download needed
- **Token-aware output** — files sorted by size, included until a configurable token budget is reached
- **File filtering** — by extension, directory, path, or VS Code-style glob patterns
- **Content search** — find files by content with plain text, case-sensitive, or regex matching
- **`.genignore` support** — like `.gitignore`, but for controlling what AI tools see
- **Multiple output formats** — HTML (default), JSON, YAML, Markdown
- **Issues, PRs, and discussions** — view threads and comments, not just code
- **OAuth + API keys** — free for public repos (GitHub login required), API keys for programmatic access
- **MCP-compatible OAuth** — any MCP client can authenticate and get an API key

## Quick Start

### In the browser

Visit `https://uithub.com/{owner}/{repo}` for any public GitHub repo.

### As a Claude Code skill

```bash
npx skills add janwilmake/uithub
```

This installs a skill that automatically fetches repo contents when you paste a GitHub URL into Claude Code.

### With the CLI

```bash
npm install -g uithub
uithub facebook/react
uithub facebook/react?ext=ts,js&maxTokens=30000
uithub nodejs/node/issues/12345
```

### As a library

```bash
npm install uithub-lib
```

```typescript
import { parseGitHubZip } from "uithub-lib";

const response = await fetch(
  "https://github.com/owner/repo/archive/refs/heads/main.zip"
);

const result = await parseGitHubZip(response.body, "owner", "repo", "main", {
  maxTokens: 50000
});

console.log(result.fileString); // Formatted content ready for LLMs
console.log(result.totalTokens); // Total token count
```

## Query Parameters

| Parameter          | Description                       | Example                    |
| ------------------ | --------------------------------- | -------------------------- |
| `maxTokens`        | Token budget (default: 50,000)    | `maxTokens=30000`          |
| `ext`              | Include file extensions           | `ext=ts,js,md`             |
| `exclude-ext`      | Exclude file extensions           | `exclude-ext=test.ts`      |
| `dir`              | Include directories               | `dir=src,lib`              |
| `exclude-dir`      | Exclude directories               | `exclude-dir=node_modules` |
| `include`          | Glob patterns to include          | `include=src/**/*.ts`      |
| `exclude`          | Glob patterns to exclude          | `exclude=**/*.test.ts`     |
| `search`           | Search file contents              | `search=useState`          |
| `searchMatchCase`  | Case-sensitive search             | `searchMatchCase=true`     |
| `searchRegularExp` | Regex search                      | `searchRegularExp=true`    |
| `maxFileSize`      | Max file size in bytes            | `maxFileSize=100000`       |
| `accept`           | Response format                   | `accept=application/json`  |
| `omitFiles`        | Only return the tree, no contents | `omitFiles=true`           |
| `omitTree`         | Omit directory tree               | `omitTree=true`            |
| `lines`            | Show line numbers (default: true) | `lines=false`              |
| `disableGenignore` | Disable .genignore processing     | `disableGenignore=true`    |

## Project Structure

This is a monorepo with three packages:

| Package    | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `website/` | Cloudflare Worker — the main uithub.com site and API          |
| `lib/`     | `uithub-lib` — standalone ZIP parsing and formatting library  |
| `cli/`     | `uithub` CLI — command-line client for fetching repo contents |
| `skills/`  | Claude Code skill for automatic GitHub URL fetching           |

### Website modules

| File                   | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `website/index.ts`     | Main router — dispatches requests to handlers based on URL      |
| `website/auth.ts`      | OAuth 2.0 server, GitHub login, session/token management        |
| `website/repo.ts`      | Fetches repos, streams ZIP, renders content (HTML/JSON/YAML/MD) |
| `website/owner.ts`     | User profile page — lists repositories                          |
| `website/threads.ts`   | Lists issues, PRs, discussions for a repo                       |
| `website/thread.ts`    | Single issue/discussion view with comments                      |
| `website/dashboard.ts` | User dashboard — API keys, OAuth clients, balance               |
| `website/analytics.ts` | Request tracking via Durable Objects + admin dashboard          |
| `website/stripe.ts`    | Stripe webhook — processes payments, adds credit                |

## How It Works

1. You visit `uithub.com/{owner}/{repo}`
2. uithub fetches the repo ZIP from GitHub's archive API
3. The ZIP is streamed and parsed on the edge (Cloudflare Workers) — no full download
4. Files are filtered by `.genignore`, your query parameters, and token budget
5. The result is returned as a formatted, token-counted view with a directory tree

## API

uithub exposes an OpenAPI-documented REST API. See the full spec at:

```
https://uithub.com/openapi.json
```

Authenticate with a Bearer token obtained through the OAuth flow or the dashboard.

## License

MIT
