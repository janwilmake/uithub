Ok so it's been a while! today i wanna bring back some version of uithub that doesn't accept bot traffic without api key

Older uithub-related code:

- https://github.com/janwilmake?tab=repositories&q=uithub
- https://github.com/janwilmake/uithub.llms
- https://github.com/janwilmake/uit
- https://github.com/janwilmake/uithub-mcp

Requirements

- ✅ Should have all features the old uithub had
- ✅ Should be free and accessible but if no API key is provided, show an unclosable popup to sign w/ github first, without private repo access
- ✅ Should stream zip contents to the result page but using Cloudflare
- ✅ Should follow MCP standard for oauth such that any client can get an API key that hides the original github key

## File Overview

| File               | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `src/index.ts`     | Main router - dispatches requests to handlers based on URL      |
| `src/auth.ts`      | OAuth 2.0 server, GitHub login, session/token management        |
| `src/repo.ts`      | Fetches repos, streams ZIP, renders content (HTML/JSON/YAML/MD) |
| `src/owner.ts`     | User profile page - lists repositories                          |
| `src/parse-zip.ts` | Streaming ZIP parser with `.genignore` and token filtering      |
| `src/threads.ts`   | Lists issues, PRs, discussions for a repo                       |
| `src/thread.ts`    | Single issue/discussion view with comments                      |
| `src/dashboard.ts` | User dashboard - API keys, OAuth clients, balance               |
| `src/analytics.ts` | Request tracking via Durable Objects + admin dashboard          |
| `src/stripe.ts`    | Stripe webhook - processes payments, adds credit                |
