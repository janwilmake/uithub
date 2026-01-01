import { handleOwnerEndpoint } from "./owner";
import { handleRepoEndpoint } from "./repo";
import { type Env, authMiddleware } from "./auth";
import { handleStripeWebhook } from "./stripe";

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

    const [_, owner, repo] = url.pathname.split("/");

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

    // Repository content
    return handleRepoEndpoint(request, env);
  },
};
