import { type Env, getUser, createUnauthorizedResponse } from "./auth";
import { stringify } from "yaml";
import {
  parseZipStreaming,
  type StreamingParseContext,
  type ContentType
} from "../lib/src";

// ==================== TYPES ====================

type ThreadType = "issues" | "discussions";

interface Author {
  login: string;
  avatarUrl: string;
  url: string;
}

interface Comment {
  id: string;
  body: string;
  author: Author;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface ThreadDetail {
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
    types: Array<{ type: string; count: number }>;
  };
  comments: Comment[];
}

// ==================== GITHUB API HELPERS ====================

async function fetchAllComments(
  owner: string,
  repo: string,
  number: string,
  token: string | null
): Promise<Comment[]> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub"
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const allComments: Comment[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?page=${page}&per_page=100`,
      { headers }
    );

    if (!response.ok) {
      break;
    }

    const comments = await response.json();

    if (comments.length === 0) {
      hasMore = false;
    } else {
      allComments.push(
        ...comments.map((c: any) => ({
          id: String(c.id),
          body: c.body,
          author: {
            login: c.user.login,
            avatarUrl: c.user.avatar_url,
            url: c.user.html_url
          },
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          url: c.html_url
        }))
      );
      page++;
    }

    const linkHeader = response.headers.get("Link");
    if (!linkHeader?.includes('rel="next"')) {
      hasMore = false;
    }
  }

  return allComments;
}

async function fetchIssue(
  owner: string,
  repo: string,
  number: string,
  token: string | null
): Promise<ThreadDetail> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub"
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const issueResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    { headers }
  );

  if (!issueResponse.ok) {
    throw new Error(`GitHub API error: ${issueResponse.status}`);
  }

  const issue = await issueResponse.json();
  const comments = await fetchAllComments(owner, repo, number, token);

  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    author: {
      login: issue.user.login,
      avatarUrl: issue.user.avatar_url,
      url: issue.user.html_url
    },
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: issue.html_url,
    state: issue.state,
    type: "issues",
    labels: issue.labels.map((l: any) => l.name),
    reactions: {
      totalCount: issue.reactions?.total_count || 0,
      types: []
    },
    comments
  };
}

async function fetchAllDiscussionComments(
  owner: string,
  repo: string,
  discussionId: string,
  token: string | null
): Promise<Comment[]> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub"
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const graphqlQuery = `
    query($owner: String!, $repo: String!, $discussionId: ID!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        discussion(id: $discussionId) {
          comments(first: 100, after: $cursor) {
            nodes {
              id
              body
              author {
                login
                avatarUrl
                url
              }
              createdAt
              updatedAt
              url
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  const allComments: Comment[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { owner, repo, discussionId, cursor }
      })
    });

    if (!response.ok) {
      break;
    }

    const data = await response.json();
    const comments = data.data?.repository?.discussion?.comments;

    if (!comments) {
      break;
    }

    allComments.push(
      ...comments.nodes.map((c: any) => ({
        id: c.id,
        body: c.body,
        author: {
          login: c.author?.login || "unknown",
          avatarUrl: c.author?.avatarUrl || "",
          url: c.author?.url || ""
        },
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        url: c.url
      }))
    );

    hasNextPage = comments.pageInfo.hasNextPage;
    cursor = comments.pageInfo.endCursor;
  }

  return allComments;
}

async function fetchDiscussion(
  owner: string,
  repo: string,
  number: string,
  token: string | null
): Promise<ThreadDetail> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub"
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const graphqlQuery = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
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
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: {
        owner,
        repo,
        number: parseInt(number, 10)
      }
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const discussion = data.data?.repository?.discussion;

  if (!discussion) {
    throw new Error("Discussion not found");
  }

  const comments = await fetchAllDiscussionComments(
    owner,
    repo,
    discussion.id,
    token
  );

  return {
    id: discussion.id,
    number: discussion.number,
    title: discussion.title,
    body: discussion.body || "",
    author: {
      login: discussion.author?.login || "unknown",
      avatarUrl: discussion.author?.avatarUrl || "",
      url: discussion.author?.url || ""
    },
    createdAt: discussion.createdAt,
    updatedAt: discussion.updatedAt,
    url: discussion.url,
    state: discussion.closed ? "closed" : "open",
    type: "discussions",
    labels: discussion.labels?.nodes?.map((l: any) => l.name) || [],
    reactions: {
      totalCount: discussion.reactions?.totalCount || 0,
      types: []
    },
    comments
  };
}

// ==================== RELEVANT CONTENTS FETCHER ====================

async function fetchRelevantContents(
  owner: string,
  repo: string,
  thread: ThreadDetail,
  token: string | null,
  params: {
    maxTokens: number;
    shouldAddLineNumbers: boolean;
    includeExt?: string[];
    excludeExt?: string[];
    disableGenignore: boolean;
    maxFileSize?: number;
  }
): Promise<{ [path: string]: ContentType } | null> {
  const allText = [thread.body, ...thread.comments.map((c) => c.body)].join(
    "\n"
  );

  const filePathRegex = /`([^`]+\.[a-zA-Z]+)`/g;
  const filePaths = new Set<string>();
  let match;

  while ((match = filePathRegex.exec(allText)) !== null) {
    const path = match[1];
    if (path.includes("/") || path.includes(".")) {
      filePaths.add(path);
    }
  }

  if (filePaths.size === 0) {
    return null;
  }

  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub"
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const response = await fetch(
    `https://github.com/${owner}/${repo}/archive/HEAD.zip`,
    { headers }
  );

  if (!response.ok || !response.body) {
    return null;
  }

  const parseContext: StreamingParseContext = {
    owner,
    repo,
    excludeExt: params.excludeExt,
    includeExt: params.includeExt,
    paths: Array.from(filePaths),
    disableGenignore: params.disableGenignore,
    maxFileSize: params.maxFileSize,
    maxTokens: params.maxTokens,
    shouldAddLineNumbers: params.shouldAddLineNumbers
  };

  const result = await parseZipStreaming(response.body, parseContext);
  return result.result || null;
}

// ==================== HTML GENERATION ====================

function generateThreadHTML(
  owner: string,
  repo: string,
  thread: ThreadDetail,
  relevantContents: { [path: string]: ContentType } | null
): string {
  const typeLabel = thread.type === "issues" ? "Issue" : "Discussion";
  const markdownContent = generateThreadMarkdown(
    owner,
    repo,
    thread,
    relevantContents
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>#${thread.number} ${thread.title} - ${owner}/${repo}</title>
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
      font-size: 2em;
      margin: 0 0 16px;
    }
    .thread-meta {
      display: flex;
      gap: 20px;
      font-size: 14px;
      opacity: 0.7;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
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
    }
    .label {
      background: rgba(139, 92, 246, 0.2);
      color: #8b5cf6;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
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
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
    }
    .copy-btn:hover {
      background: rgba(139, 92, 246, 0.3);
    }
    .content-section {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .author-info {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
    }
    .author-name {
      font-weight: 600;
    }
    .timestamp {
      opacity: 0.7;
      font-size: 14px;
    }
    .body {
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .comments-section {
      margin-top: 40px;
    }
    .comments-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .comment {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .relevant-contents {
      margin-top: 40px;
    }
    .file-content {
      background: #1a1a1a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      overflow-x: auto;
    }
    .file-path {
      color: #8b5cf6;
      font-weight: 600;
      margin-bottom: 8px;
    }
    pre {
      margin: 0;
      white-space: pre;
      font-family: monospace;
      font-size: 14px;
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
        <a href="/${owner}">${owner}</a> / 
        <a href="/${owner}/${repo}">${repo}</a> / 
        <a href="/${owner}/${repo}/${thread.type}">${typeLabel}s</a> / 
        #${thread.number}
      </div>
      <h1>${escapeHtml(thread.title)}</h1>
      <div class="thread-meta">
        <span class="thread-state ${
          thread.state === "open" ? "state-open" : "state-closed"
        }">
          ${thread.state}
        </span>
        <span>Opened by @${thread.author.login}</span>
        <span>${new Date(thread.createdAt).toLocaleDateString()}</span>
        ${
          thread.reactions.totalCount > 0
            ? `<span>❤️ ${thread.reactions.totalCount}</span>`
            : ""
        }
      </div>
      ${
        thread.labels.length > 0
          ? `
        <div class="labels">
          ${thread.labels
            .map((label) => `<span class="label">${escapeHtml(label)}</span>`)
            .join("")}
        </div>
      `
          : ""
      }
      <button class="copy-btn" id="copyBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span id="copyText">Copy as Markdown</span>
      </button>
    </div>

    <div class="content-section">
      <div class="author-info">
        <img src="${thread.author.avatarUrl}" alt="${
          thread.author.login
        }" class="avatar">
        <div>
          <div class="author-name">@${thread.author.login}</div>
          <div class="timestamp">${new Date(
            thread.createdAt
          ).toLocaleString()}</div>
        </div>
      </div>
      <div class="body">${escapeHtml(thread.body)}</div>
    </div>

    ${
      thread.comments.length > 0
        ? `
      <div class="comments-section">
        <div class="comments-header">
          <h2>${thread.comments.length} Comment${
            thread.comments.length !== 1 ? "s" : ""
          }</h2>
        </div>
        ${thread.comments
          .map(
            (comment) => `
          <div class="comment">
            <div class="author-info">
              <img src="${comment.author.avatarUrl}" alt="${
                comment.author.login
              }" class="avatar">
              <div>
                <div class="author-name">@${comment.author.login}</div>
                <div class="timestamp">${new Date(
                  comment.createdAt
                ).toLocaleString()}</div>
              </div>
            </div>
            <div class="body">${escapeHtml(comment.body)}</div>
          </div>
        `
          )
          .join("")}
      </div>
    `
        : ""
    }

    ${
      relevantContents && Object.keys(relevantContents).length > 0
        ? `
      <div class="relevant-contents">
        <h2>Relevant Files</h2>
        ${Object.entries(relevantContents)
          .map(
            ([path, content]) => `
          <div class="file-content">
            <div class="file-path">${escapeHtml(path)}</div>
            <pre>${escapeHtml(
              content.type === "content"
                ? content.content || ""
                : `Binary file: ${content.url}`
            )}</pre>
          </div>
        `
          )
          .join("")}
      </div>
    `
        : ""
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
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateThreadMarkdown(
  owner: string,
  repo: string,
  thread: ThreadDetail,
  relevantContents: { [path: string]: ContentType } | null
): string {
  const typeLabel = thread.type === "issues" ? "Issue" : "Discussion";

  return `# ${owner}/${repo} - ${typeLabel} #${thread.number}

## ${thread.title}

**Status:** ${thread.state}
**Author:** @${thread.author.login}
**Created:** ${new Date(thread.createdAt).toLocaleString()}
**Updated:** ${new Date(thread.updatedAt).toLocaleString()}
**URL:** ${thread.url}
${thread.labels.length > 0 ? `**Labels:** ${thread.labels.join(", ")}` : ""}
${
  thread.reactions.totalCount > 0
    ? `**Reactions:** ${thread.reactions.totalCount}`
    : ""
}

---

${thread.body}

${
  thread.comments.length > 0
    ? `
---

## Comments (${thread.comments.length})

${thread.comments
  .map(
    (comment, index) => `
### Comment ${index + 1} by @${comment.author.login}
*${new Date(comment.createdAt).toLocaleString()}*

${comment.body}

---
`
  )
  .join("\n")}
`
    : ""
}

${
  relevantContents && Object.keys(relevantContents).length > 0
    ? `
---

## Relevant Files

${Object.entries(relevantContents)
  .map(
    ([path, content]) => `
### ${path}

\`\`\`
${content.type === "content" ? content.content : `Binary file: ${content.url}`}
\`\`\`
`
  )
  .join("\n")}
`
    : ""
}`;
}

// ==================== MAIN HANDLER ====================

export async function handleThread(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const [_, owner, repo, threadType, number] = url.pathname.split("/");

  if (!["issues", "discussions"].includes(threadType)) {
    return new Response("Invalid thread type", { status: 400 });
  }

  const { currentUser, githubAccessToken } = await getUser(request, env);

  if (!currentUser) {
    const acceptHeader = request.headers.get("Accept") || "";
    if (acceptHeader.includes("text/html")) {
      const loginUrl = `${
        url.origin
      }/login?scope=user:email&redirect_to=${encodeURIComponent(
        url.pathname + url.search
      )}`;
      return Response.redirect(loginUrl, 302);
    }
    return createUnauthorizedResponse(url);
  }

  try {
    let thread: ThreadDetail;

    if (threadType === "issues") {
      thread = await fetchIssue(owner, repo, number, githubAccessToken);
    } else {
      thread = await fetchDiscussion(owner, repo, number, githubAccessToken);
    }

    const maxTokens = parseInt(
      url.searchParams.get("maxTokens") || "50000",
      10
    );
    const shouldAddLineNumbers = url.searchParams.get("lines") !== "false";
    const includeExt = url.searchParams.get("ext")?.split(",");
    const excludeExt = url.searchParams.get("exclude-ext")?.split(",");
    const disableGenignore =
      url.searchParams.get("disableGenignore") === "true";
    const maxFileSize =
      parseInt(url.searchParams.get("maxFileSize") || "0", 10) || undefined;

    const relevantContents = await fetchRelevantContents(
      owner,
      repo,
      thread,
      githubAccessToken,
      {
        maxTokens,
        shouldAddLineNumbers,
        includeExt,
        excludeExt,
        disableGenignore,
        maxFileSize
      }
    );

    const acceptParam = url.searchParams.get("accept");
    const acceptHeader = request.headers.get("Accept") || "";

    if (
      acceptParam === "application/json" ||
      acceptHeader.includes("application/json")
    ) {
      return new Response(
        JSON.stringify({ thread, relevantContents }, null, 2),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (acceptParam === "text/yaml" || acceptHeader.includes("text/yaml")) {
      return new Response(stringify({ thread, relevantContents }), {
        headers: { "Content-Type": "text/yaml" }
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
        generateThreadMarkdown(owner, repo, thread, relevantContents),
        {
          headers: { "Content-Type": "text/markdown; charset=utf-8" }
        }
      );
    }

    return new Response(
      generateThreadHTML(owner, repo, thread, relevantContents),
      {
        headers: {
          "Content-Type": "text/html",
          "X-XSS-Protection": "1; mode=block",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY"
        }
      }
    );
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
}
