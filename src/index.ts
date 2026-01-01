import { handleOwnerEndpoint } from "./owner";
import { handleRepoEndpoint } from "./repo";
import { type Env, authMiddleware } from "./auth";
import { handleStripeWebhook } from "./stripe";
import { handleDashboard } from "./dashboard";
import { handleThreads } from "./threads";
import { handleThread } from "./thread";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    const [_, owner, repo, page, branch, ...pathParts] =
      url.pathname.split("/");

    // Root
    if (!owner) {
      return new Response(
        "Welcome to uithub - GitHub repos optimized for LLMs. Sign in to get started.",
        {
          headers: { "Content-Type": "text/html" },
        },
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
