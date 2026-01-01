import { type Env, getUser } from "./auth";

function generateProfileHTML(owner: string, repos: any[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${owner}'s Repositories</title>
  <style>
    body { margin: 0; font-family: system-ui; background: #1a1a1a; color: #f0f0f0; padding: 20px; }
    .header { text-align: center; margin-bottom: 40px; }
    h1 { background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 3em; margin: 0; }
    .repos { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .repo { background: #2a2a2a; padding: 20px; border-radius: 8px; transition: transform 0.2s; }
    .repo:hover { transform: translateY(-4px); background: #333; }
    .repo-name { font-size: 1.2em; font-weight: bold; color: #8b5cf6; margin-bottom: 10px; }
    .repo-desc { opacity: 0.8; margin-bottom: 10px; }
    .repo-meta { display: flex; gap: 15px; font-size: 0.9em; opacity: 0.6; }
    a { color: inherit; text-decoration: none; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${owner}'s Repositories</h1>
    <p>${repos.length} repositories</p>
  </div>
  <div class="repos">
    ${repos
      .map(
        (repo) => `
      <a href="/${owner}/${repo.name}/tree/${repo.default_branch || "main"}">
        <div class="repo">
          <div class="repo-name">${repo.name}</div>
          <div class="repo-desc">${repo.description || "No description"}</div>
          <div class="repo-meta">
            <span>⭐ ${repo.stargazers_count || 0}</span>
            ${
              repo.private
                ? "<span>🔒 Private</span>"
                : "<span>🌐 Public</span>"
            }
            ${repo.archived ? "<span>📦 Archived</span>" : ""}
          </div>
        </div>
      </a>
    `,
      )
      .join("")}
  </div>
</body>
</html>`;
}

export async function handleOwnerEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const [_, owner] = url.pathname.split("/");

  const { currentUser, githubAccessToken } = await getUser(request, env);

  if (!currentUser) {
    const loginUrl = `${
      url.origin
    }/login?scope=user:email&resource=${encodeURIComponent(
      url.origin,
    )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;
    return Response.redirect(loginUrl, 302);
  }

  try {
    const headers: HeadersInit = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "uithub",
    };
    if (githubAccessToken)
      headers["Authorization"] = `token ${githubAccessToken}`;

    const response = await fetch(
      `https://api.github.com/users/${owner}/repos?per_page=100`,
      {
        headers,
      },
    );

    if (!response.ok) {
      return new Response(
        `User not found: ${owner} (${
          response.status
        }, ${await response.text()})`,
        { status: 404 },
      );
    }

    const repos: {}[] = await response.json();

    // Check if markdown is requested
    const acceptHeader = request.headers.get("Accept") || "";
    if (
      acceptHeader === "*/*" ||
      acceptHeader === "" ||
      acceptHeader.includes("text/markdown")
    ) {
      const markdown = `# ${owner}'s repos (${repos.length}):\n\n${repos
        .map(
          (r: any) =>
            `- ${r.name} (${r.stargazers_count} stars${
              r.archived ? " archived" : ""
            }${r.private ? " private" : ""}) ${r.description || ""}`,
        )
        .join("\n")}`;
      return new Response(markdown, {
        headers: { "Content-Type": "text/markdown;charset=utf8" },
      });
    }

    return new Response(generateProfileHTML(owner, repos), {
      headers: { "Content-Type": "text/html" },
    });
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
}
