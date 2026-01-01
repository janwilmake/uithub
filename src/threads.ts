import { type Env, getUser, createUnauthorizedResponse } from "./auth";
import { stringify } from "yaml";

// ==================== TYPES ====================

type ThreadType = "issues" | "pulls" | "discussions";

interface Author {
  login: string;
  avatarUrl: string;
  url: string;
}

interface ThreadItem {
  id: string;
  number: number;
  title: string;
  body: string;
  author: Author;
  createdAt: string;
  updatedAt: string;
  url: string;
  state: "open" | "closed";
  type: ThreadType;
  labels: string[];
  reactions: {
    totalCount: number;
  };
}

interface ThreadsResponse {
  items: ThreadItem[];
  totalCount: number;
  page: number;
  hasNextPage: boolean;
}

// ==================== GITHUB API HELPERS ====================

async function fetchIssues(
  owner: string,
  repo: string,
  page: number,
  query: string | null,
  token: string | null,
): Promise<ThreadsResponse> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const params = new URLSearchParams({
    page: String(page),
    per_page: "30",
    state: "all",
    sort: "updated",
    direction: "desc",
  });

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?${params}`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const items = (data as any[])
    .filter((item) => !item.pull_request)
    .filter((item) => {
      if (!query) return true;
      const searchText = `${item.title} ${item.body}`.toLowerCase();
      return searchText.includes(query.toLowerCase());
    })
    .map((item) => ({
      id: String(item.id),
      number: item.number,
      title: item.title,
      body: item.body || "",
      author: {
        login: item.user.login,
        avatarUrl: item.user.avatar_url,
        url: item.user.html_url,
      },
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      url: item.html_url,
      state: item.state,
      type: "issues" as ThreadType,
      labels: item.labels.map((l: any) => l.name),
      reactions: {
        totalCount: item.reactions?.total_count || 0,
      },
    }));

  const linkHeader = response.headers.get("Link");
  const hasNextPage = linkHeader?.includes('rel="next"') || false;

  return {
    items,
    totalCount: items.length,
    page,
    hasNextPage,
  };
}

async function fetchPulls(
  owner: string,
  repo: string,
  page: number,
  query: string | null,
  token: string | null,
): Promise<ThreadsResponse> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const params = new URLSearchParams({
    page: String(page),
    per_page: "30",
    state: "all",
    sort: "updated",
    direction: "desc",
  });

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?${params}`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const items = (data as any[])
    .filter((item) => {
      if (!query) return true;
      const searchText = `${item.title} ${item.body}`.toLowerCase();
      return searchText.includes(query.toLowerCase());
    })
    .map((item) => ({
      id: String(item.id),
      number: item.number,
      title: item.title,
      body: item.body || "",
      author: {
        login: item.user.login,
        avatarUrl: item.user.avatar_url,
        url: item.user.html_url,
      },
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      url: item.html_url,
      state: item.state,
      type: "pulls" as ThreadType,
      labels: item.labels.map((l: any) => l.name),
      reactions: {
        totalCount: 0,
      },
    }));

  const linkHeader = response.headers.get("Link");
  const hasNextPage = linkHeader?.includes('rel="next"') || false;

  return {
    items,
    totalCount: items.length,
    page,
    hasNextPage,
  };
}

async function fetchDiscussions(
  owner: string,
  repo: string,
  page: number,
  query: string | null,
  token: string | null,
): Promise<ThreadsResponse> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const graphqlQuery = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        discussions(first: 30, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            id
            number
            title
            body
            author {
              login
              avatarUrl
              url
            }
            createdAt
            updatedAt
            url
            closed
            labels(first: 10) {
              nodes {
                name
              }
            }
            reactions {
              totalCount
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: {
        owner,
        repo,
        cursor: page > 1 ? btoa(`cursor:${(page - 1) * 30}`) : null,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const discussions = data.data?.repository?.discussions?.nodes || [];
  const pageInfo = data.data?.repository?.discussions?.pageInfo || {};

  const items = discussions
    .filter((item: any) => {
      if (!query) return true;
      const searchText = `${item.title} ${item.body}`.toLowerCase();
      return searchText.includes(query.toLowerCase());
    })
    .map((item: any) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      body: item.body || "",
      author: {
        login: item.author?.login || "unknown",
        avatarUrl: item.author?.avatarUrl || "",
        url: item.author?.url || "",
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      url: item.url,
      state: item.closed ? "closed" : "open",
      type: "discussions" as ThreadType,
      labels: item.labels?.nodes?.map((l: any) => l.name) || [],
      reactions: {
        totalCount: item.reactions?.totalCount || 0,
      },
    }));

  return {
    items,
    totalCount: items.length,
    page,
    hasNextPage: pageInfo.hasNextPage || false,
  };
}

// ==================== HTML GENERATION ====================

function generateThreadsHTML(
  owner: string,
  repo: string,
  threadType: ThreadType,
  response: ThreadsResponse,
  query: string | null,
): string {
  const typeLabel =
    threadType === "issues"
      ? "Issues"
      : threadType === "pulls"
      ? "Pull Requests"
      : "Discussions";

  const markdownContent = generateThreadsMarkdown(
    owner,
    repo,
    threadType,
    response,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${owner}/${repo} - ${typeLabel}</title>
  <style>
    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a1a1a;
      color: #f0f0f0;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      margin-bottom: 40px;
    }
    .breadcrumb {
      opacity: 0.7;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .breadcrumb a {
      color: #8b5cf6;
      text-decoration: none;
    }
    .breadcrumb a:hover {
      text-decoration: underline;
    }
    h1 {
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 2.5em;
      margin: 0 0 16px;
    }
    .controls {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 24px;
    }
    .nav-tabs {
      display: flex;
      gap: 8px;
      background: #2a2a2a;
      padding: 4px;
      border-radius: 12px;
    }
    .nav-tab {
      padding: 8px 16px;
      border-radius: 8px;
      text-decoration: none;
      color: #f0f0f0;
      transition: all 0.2s;
      font-size: 14px;
      font-weight: 500;
    }
    .nav-tab:hover {
      background: rgba(139, 92, 246, 0.2);
    }
    .nav-tab.active {
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
    }
    .search-box {
      display: flex;
      gap: 8px;
      flex: 1;
      max-width: 400px;
    }
    .search-input {
      flex: 1;
      background: #2a2a2a;
      border: 1px solid #444;
      color: #f0f0f0;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
    }
    .search-btn {
      background: #8b5cf6;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    }
    .search-btn:hover {
      background: #7c3aed;
    }
    .copy-btn {
      background: rgba(139, 92, 246, 0.2);
      border: 1px solid #8b5cf6;
      color: #8b5cf6;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .copy-btn:hover {
      background: rgba(139, 92, 246, 0.3);
    }
    .subtitle {
      opacity: 0.7;
      margin-bottom: 24px;
    }
    .thread-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .thread-item {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 20px;
      transition: transform 0.2s;
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .thread-item:hover {
      transform: translateY(-2px);
      background: #333;
    }
    .thread-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .thread-number {
      font-size: 14px;
      opacity: 0.5;
    }
    .thread-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .thread-meta {
      display: flex;
      gap: 20px;
      font-size: 14px;
      opacity: 0.7;
      flex-wrap: wrap;
    }
    .thread-state {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .state-open {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }
    .state-closed {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .labels {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .label {
      background: rgba(139, 92, 246, 0.2);
      color: #8b5cf6;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
    }
    .pagination {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-top: 40px;
    }
    .page-btn {
      background: #2a2a2a;
      color: #f0f0f0;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    .page-btn:hover {
      background: #333;
    }
    .page-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      opacity: 0.5;
    }
    textarea {
      position: absolute;
      left: -9999px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="breadcrumb">
        <a href="/${owner}">${owner}</a> / <a href="/${owner}/${repo}">${repo}</a>
      </div>
      <h1>${typeLabel}</h1>
      <div class="subtitle">${response.items.length} items</div>
    </div>

    <div class="controls">
      <div class="nav-tabs">
        <a href="/${owner}/${repo}/issues${
    query ? `?q=${encodeURIComponent(query)}` : ""
  }" 
           class="nav-tab ${threadType === "issues" ? "active" : ""}">
          Issues
        </a>
        <a href="/${owner}/${repo}/pulls${
    query ? `?q=${encodeURIComponent(query)}` : ""
  }" 
           class="nav-tab ${threadType === "pulls" ? "active" : ""}">
          Pull Requests
        </a>
        <a href="/${owner}/${repo}/discussions${
    query ? `?q=${encodeURIComponent(query)}` : ""
  }" 
           class="nav-tab ${threadType === "discussions" ? "active" : ""}">
          Discussions
        </a>
      </div>

      <form class="search-box" method="GET">
        <input 
          type="search" 
          name="q" 
          class="search-input" 
          placeholder="Search ${typeLabel.toLowerCase()}..." 
          value="${query || ""}"
        >
        <button type="submit" class="search-btn">Search</button>
      </form>

      <button class="copy-btn" id="copyBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span id="copyText">Copy as Markdown</span>
      </button>
    </div>

    ${
      response.items.length === 0
        ? `<div class="empty-state">No ${typeLabel.toLowerCase()} found${
            query ? ` matching "${query}"` : ""
          }.</div>`
        : `
    <div class="thread-list">
      ${response.items
        .map(
          (item) => `
        <a href="/${owner}/${repo}/${threadType}/${
            item.number
          }" class="thread-item">
          <div class="thread-header">
            <span class="thread-number">#${item.number}</span>
            <span class="thread-state ${
              item.state === "open" ? "state-open" : "state-closed"
            }">
              ${item.state}
            </span>
          </div>
          <div class="thread-title">${escapeHtml(item.title)}</div>
          <div class="thread-meta">
            <span>by @${item.author.login}</span>
            <span>${new Date(item.createdAt).toLocaleDateString()}</span>
            ${
              item.reactions.totalCount > 0
                ? `<span>❤️ ${item.reactions.totalCount}</span>`
                : ""
            }
          </div>
          ${
            item.labels.length > 0
              ? `
            <div class="labels">
              ${item.labels
                .map(
                  (label) => `<span class="label">${escapeHtml(label)}</span>`,
                )
                .join("")}
            </div>
          `
              : ""
          }
        </a>
      `,
        )
        .join("")}
    </div>

    <div class="pagination">
      ${
        response.page > 1
          ? `<a href="?page=${response.page - 1}${
              query ? `&q=${encodeURIComponent(query)}` : ""
            }" class="page-btn">Previous</a>`
          : ""
      }
      <span class="page-btn" disabled>Page ${response.page}</span>
      ${
        response.hasNextPage
          ? `<a href="?page=${response.page + 1}${
              query ? `&q=${encodeURIComponent(query)}` : ""
            }" class="page-btn">Next</a>`
          : ""
      }
    </div>
    `
    }
  </div>

  <textarea id="markdownContent">${escapeHtml(markdownContent)}</textarea>

  <script>
    const copyBtn = document.getElementById('copyBtn');
    const copyText = document.getElementById('copyText');
    const markdownContent = document.getElementById('markdownContent');

    copyBtn.addEventListener('click', () => {
      markdownContent.select();
      document.execCommand('copy');
      const originalText = copyText.textContent;
      copyText.textContent = 'Copied!';
      setTimeout(() => {
        copyText.textContent = originalText;
      }, 2000);
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  const div = { textContent: text } as any;
  return div.textContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateThreadsMarkdown(
  owner: string,
  repo: string,
  threadType: ThreadType,
  response: ThreadsResponse,
): string {
  const typeLabel =
    threadType === "issues"
      ? "Issues"
      : threadType === "pulls"
      ? "Pull Requests"
      : "Discussions";

  return `# ${owner}/${repo} - ${typeLabel}

${response.items
  .map(
    (item) => `
## #${item.number} ${item.title} [${item.state}]

**Author:** @${item.author.login}
**Created:** ${new Date(item.createdAt).toLocaleDateString()}
**Updated:** ${new Date(item.updatedAt).toLocaleDateString()}
**URL:** ${item.url}
${item.labels.length > 0 ? `**Labels:** ${item.labels.join(", ")}` : ""}
${
  item.reactions.totalCount > 0
    ? `**Reactions:** ${item.reactions.totalCount}`
    : ""
}

${item.body}

---
`,
  )
  .join("\n")}

Page ${response.page}${response.hasNextPage ? " (more available)" : ""}`;
}

// ==================== MAIN HANDLER ====================

export async function handleThreads(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const [_, owner, repo, threadType] = url.pathname.split("/");

  if (!["issues", "pulls", "discussions"].includes(threadType)) {
    return new Response("Invalid thread type", { status: 400 });
  }

  const { currentUser, githubAccessToken } = await getUser(request, env);

  if (!currentUser) {
    const acceptHeader = request.headers.get("Accept") || "";
    if (acceptHeader.includes("text/html")) {
      const loginUrl = `${
        url.origin
      }/login?scope=user:email&redirect_to=${encodeURIComponent(
        url.pathname + url.search,
      )}`;
      return Response.redirect(loginUrl, 302);
    }
    return createUnauthorizedResponse(url, "read");
  }

  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const query = url.searchParams.get("q") || null;

  try {
    let response: ThreadsResponse;

    switch (threadType as ThreadType) {
      case "issues":
        response = await fetchIssues(
          owner,
          repo,
          page,
          query,
          githubAccessToken,
        );
        break;
      case "pulls":
        response = await fetchPulls(
          owner,
          repo,
          page,
          query,
          githubAccessToken,
        );
        break;
      case "discussions":
        response = await fetchDiscussions(
          owner,
          repo,
          page,
          query,
          githubAccessToken,
        );
        break;
      default:
        return new Response("Invalid thread type", { status: 400 });
    }

    const acceptParam = url.searchParams.get("accept");
    const acceptHeader = request.headers.get("Accept") || "";

    if (
      acceptParam === "application/json" ||
      acceptHeader.includes("application/json")
    ) {
      return new Response(JSON.stringify(response, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (acceptParam === "text/yaml" || acceptHeader.includes("text/yaml")) {
      return new Response(stringify(response), {
        headers: { "Content-Type": "text/yaml" },
      });
    }

    if (
      acceptParam === "text/markdown" ||
      acceptParam === "text/plain" ||
      acceptHeader.includes("text/markdown") ||
      acceptHeader.includes("text/plain") ||
      acceptHeader === "*/*" ||
      acceptHeader === ""
    ) {
      return new Response(
        generateThreadsMarkdown(
          owner,
          repo,
          threadType as ThreadType,
          response,
        ),
        {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        },
      );
    }

    return new Response(
      generateThreadsHTML(
        owner,
        repo,
        threadType as ThreadType,
        response,
        query,
      ),
      {
        headers: {
          "Content-Type": "text/html",
          "X-XSS-Protection": "1; mode=block",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      },
    );
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
}
