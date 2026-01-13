import { handleOwnerEndpoint } from "./owner";
import { handleRepoEndpoint } from "./repo";
import { type Env, authMiddleware, getUser } from "./auth";
import { handleStripeWebhook } from "./stripe";
import { handleDashboard } from "./dashboard";
import { handleThreads } from "./threads";
import { handleThread } from "./thread";
import { handleAnalytics, logAnalytics, AnalyticsDO } from "./analytics";
import { handleSocials, SocialsDO } from "./socials";

export { AnalyticsDO, SocialsDO };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle auth middleware first
    const authResponse = await authMiddleware(request, env);
    if (authResponse) return authResponse;

    // Handle Stripe webhook
    if (url.pathname === "/webhook/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    // Handle dashboard
    if (url.pathname.startsWith("/dashboard")) {
      return handleDashboard(request, env);
    }

    // Handle analytics
    if (url.pathname === "/analytics" && request.method === "GET") {
      const user = await getUser(request, env);
      if (user.currentUser?.login === "janwilmake") {
        return handleAnalytics(request, env);
      }
      return new Response("Unauthorized, only janwilmake has access", {
        status: 401,
      });
    }

    // Handle socials
    if (url.pathname === "/socials") {
      const user = await getUser(request, env);
      if (user.currentUser?.login === "janwilmake") {
        return handleSocials(request, env);
      }
      return new Response("Unauthorized, only janwilmake has access", {
        status: 401,
      });
    }

    const [_, owner, repo, page, branch, ...pathParts] =
      url.pathname.split("/");
    const path = pathParts.join("/");

    // Root
    if (!owner) {
      return new Response(
        "Welcome to uithub - GitHub repos optimized for LLMs. Sign in to get started.",
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    const realPage = page ? page : repo ? "tree" : "profile";

    const pages = [
      "tree",
      "blob",
      "commit",
      "commits",
      "issues",
      "pull",
      "pulls",
      "releases",
      "discussions",
      "graphs",
      "settings",
      "actions",
      "wiki",
      "projects",
      "security",
      "pulse",
      "network",
      "forks",
      "stargazers",
      "watchers",
      "contributors",
      "community",
      "branches",
      "tags",
      "packages",
      "deployments",
      "environments",
      "compare",
      "blame",
      "find",
    ];
    if (pages.includes(realPage)) {
      // Log analytics for all content requests (background)
      ctx.waitUntil(
        logAnalytics(request, env, {
          owner,
          repo: repo || "",
          page: realPage,
          path,
        }),
      );
    }

    // User profile page
    if (!repo) {
      return handleOwnerEndpoint(request, env);
    }

    // Threads list (issues, pulls, discussions)
    if (["issues", "pulls", "discussions"].includes(page) && !branch) {
      return handleThreads(request, env);
    }

    // Single thread (issue or discussion)
    if (
      ["issues", "discussions"].includes(page) &&
      branch &&
      !pathParts.length
    ) {
      return handleThread(request, env);
    }

    // Repository content
    return handleRepoEndpoint(request, env);
  },
};
