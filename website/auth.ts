//@ts-check
/// <reference lib="esnext" />
/// <reference types="@cloudflare/workers-types" />

/**
 * AUTH.TS - Authentication and OAuth 2.0 Implementation
 *
 * This file handles all authentication and OAuth 2.0 flows for uithub, including:
 *
 * 1. OAUTH 2.0 AUTHORIZATION SERVER
 *    - Authorization endpoint (/authorize)
 *    - Token endpoint (/token)
 *    - Dynamic client registration (/register)
 *    - PKCE (Proof Key for Code Exchange) support
 *    - Authorization code flow
 *    - Access token generation and validation
 *
 * 2. WELL-KNOWN ENDPOINTS
 *    - OAuth Protected Resource metadata (/.well-known/oauth-protected-resource)
 *    - OAuth Authorization Server metadata (/.well-known/oauth-authorization-server)
 *    - OpenID Configuration (/.well-known/openid-configuration)
 *
 * 3. GITHUB OAUTH INTEGRATION
 *    - GitHub OAuth app integration for user authentication
 *    - GitHub access token exchange
 *    - Scope management (user:email, repo)
 *    - Private repository access control
 *
 * 4. BROWSER SESSION MANAGEMENT
 *    - Cookie-based sessions for browser users
 *    - Session token generation and validation
 *    - Login/logout flows
 *    - OAuth callback handling
 *
 * 5. TOKEN AUTHENTICATION
 *    - Bearer token validation
 *    - WWW-Authenticate header generation
 *    - Unauthorized response handling
 *
 * 6. CLIENT MANAGEMENT
 *    - Client registration storage in KV
 *    - Client ID and secret generation
 *    - Redirect URI validation
 *
 * 7. STATE MANAGEMENT
 *    - OAuth state parameter handling
 *    - PKCE code verifier/challenge storage
 *    - Authorization code storage with TTL
 *    - Access token storage with expiration
 */

// ==================== TYPES ====================

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string;
  created_at: number;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  user_id: string;
  github_access_token: string;
  scopes: string;
  code_challenge?: string;
  code_challenge_method?: string;
  expires_at: number;
  resource?: string;
}

export interface AccessToken {
  token: string;
  client_id: string;
  user_id: string;
  github_access_token: string;
  scopes: string;
  expires_at: number;
  resource?: string;
}

interface ClientAccess {
  client_id: string;
  client_name: string;
  created_at: number;
  last_used?: number;
  scopes: string;
}

interface OAuthState {
  redirectTo?: string;
  codeVerifier: string;
  scope: string;
  clientId?: string;
  clientRedirectUri?: string;
  clientState?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
}

export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  STRIPE_SECRET: string;
  STRIPE_PAYMENT_LINK: string;
  STRIPE_PAYMENT_LINK_ID: string;
  STRIPE_WEBHOOK_SIGNING_SECRET: string;
  PARALLEL_API_KEY: string;
  KV: KVNamespace;
  ANALYTICS_DO: DurableObjectNamespace<import("./analytics").AnalyticsDO>;
  SOCIALS_DO: DurableObjectNamespace<import("./socials").SocialsDO>;
}

export interface UserAccount {
  credit: number;
  username: string;
  profile_picture: string;
  private_granted: boolean;
  premium: boolean;
}

// ==================== KV HELPERS ====================

async function getRegisteredClient(
  clientId: string,
  env: Env
): Promise<RegisteredClient | null> {
  const data = await env.KV.get(`client_${clientId}`, "json");
  return data as RegisteredClient | null;
}

async function setRegisteredClient(
  client: RegisteredClient,
  env: Env
): Promise<void> {
  await env.KV.put(`client_${client.client_id}`, JSON.stringify(client));
}

async function storeAuthorizationCode(
  code: AuthorizationCode,
  env: Env
): Promise<void> {
  await env.KV.put(`auth_code_${code.code}`, JSON.stringify(code), {
    expirationTtl: 600 // 10 minutes
  });
}

async function getAuthorizationCode(
  code: string,
  env: Env
): Promise<AuthorizationCode | null> {
  const data = await env.KV.get(`auth_code_${code}`, "json");
  return data as AuthorizationCode | null;
}

async function deleteAuthorizationCode(code: string, env: Env): Promise<void> {
  await env.KV.delete(`auth_code_${code}`);
}

async function storeAccessToken(token: AccessToken, env: Env): Promise<void> {
  await env.KV.put(`access_token_${token.token}`, JSON.stringify(token), {
    expirationTtl: 86400 // 24 hours
  });
}

export async function getAccessTokenData(
  token: string,
  env: Env
): Promise<AccessToken | null> {
  const data = await env.KV.get(`access_token_${token}`, "json");
  return data as AccessToken | null;
}

export async function getUserAccount(
  userId: string,
  env: Env
): Promise<UserAccount | null> {
  const data = await env.KV.get(`user_${userId}`, "json");
  return data as UserAccount | null;
}

export async function setUserAccount(
  userId: string,
  account: UserAccount,
  env: Env
): Promise<void> {
  await env.KV.put(`user_${userId}`, JSON.stringify(account));
}

export async function createOrUpdateUser(
  userId: string,
  userData: { username: string; profile_picture: string },
  env: Env
): Promise<UserAccount> {
  const existing = await getUserAccount(userId, env);
  if (existing) {
    const updated = {
      ...existing,
      username: userData.username,
      profile_picture: userData.profile_picture
    };
    await setUserAccount(userId, updated, env);
    return updated;
  }

  const newAccount: UserAccount = {
    credit: 0,
    username: userData.username,
    profile_picture: userData.profile_picture,
    private_granted: false,
    premium: false
  };
  await setUserAccount(userId, newAccount, env);
  return newAccount;
}

// ==================== CORS HELPERS ====================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

function handleCorsPreflightRequest(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}

// ==================== CRYPTO HELPERS ====================

function generateRandomString(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(
    String.fromCharCode.apply(null, Array.from(new Uint8Array(digest)))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function verifyCodeChallenge(
  verifier: string,
  challenge: string,
  method: string
): Promise<boolean> {
  if (method === "S256") {
    const computed = await generateCodeChallenge(verifier);
    return computed === challenge;
  } else if (method === "plain") {
    return verifier === challenge;
  }
  return false;
}

// ==================== COOKIE/SESSION HELPERS ====================

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((cookie) => {
    const [name, value] = cookie.trim().split("=");
    if (name && value) {
      cookies[name] = decodeURIComponent(value);
    }
  });
  return cookies;
}

export function getSessionFromCookie(request: Request): {
  accessToken: string | null;
  user: any | null;
  scopes: string;
} {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sessionToken = cookies.session;
  if (!sessionToken) return { accessToken: null, user: null, scopes: "" };
  try {
    const bytes = Uint8Array.from(atob(sessionToken), c => c.charCodeAt(0));
    const sessionData = JSON.parse(new TextDecoder().decode(bytes));
    if (Date.now() > sessionData.exp)
      return { accessToken: null, user: null, scopes: "" };
    return {
      accessToken: sessionData.accessToken,
      user: sessionData.user,
      scopes: sessionData.scopes || ""
    };
  } catch {
    return { accessToken: null, user: null, scopes: "" };
  }
}

export function getBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

// ==================== OAUTH WELL-KNOWN ENDPOINTS ====================

function handleOAuthProtectedResource(url: URL): Response {
  return withCors(
    Response.json({
      resource: url.origin,
      authorization_servers: [url.origin]
    })
  );
}

function handleOAuthAuthorizationServer(url: URL): Response {
  return withCors(
    Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
      registration_endpoint: `${url.origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      scopes_supported: ["read", "repo"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic"
      ]
    })
  );
}

// ==================== DYNAMIC CLIENT REGISTRATION ====================

async function handleClientRegistration(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return withCors(new Response("Method not allowed", { status: 405 }));
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return withCors(
      Response.json({ error: "invalid_request" }, { status: 400 })
    );
  }

  const { redirect_uris, client_name } = body;

  if (
    !redirect_uris ||
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0
  ) {
    return withCors(
      Response.json(
        {
          error: "invalid_request",
          error_description: "redirect_uris required"
        },
        { status: 400 }
      )
    );
  }

  const clientId = `client_${generateRandomString(16)}`;
  const clientSecret = generateRandomString(32);

  const client: RegisteredClient = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris,
    client_name: client_name || "Unknown Client",
    created_at: Date.now()
  };

  await setRegisteredClient(client, env);

  return withCors(
    Response.json({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris,
      client_name: client.client_name,
      token_endpoint_auth_method: "client_secret_post"
    })
  );
}

// ==================== OAUTH CONSENT SCREEN ====================

function generateConsentScreenHTML(context: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  user: { login: string; avatar_url: string };
  formAction: string;
  hiddenFields: Record<string, string>;
}): string {
  const {
    clientName,
    clientId,
    redirectUri,
    scopes,
    user,
    formAction,
    hiddenFields
  } = context;

  const scopeDescriptions: Record<
    string,
    { label: string; description: string; warning?: string }
  > = {
    read: {
      label: "Read public repositories",
      description:
        "Access and read content from public GitHub repositories through uithub"
    },
    repo: {
      label: "Read private repositories",
      description:
        "Access and read content from your private GitHub repositories through uithub",
      warning:
        "This grants access to your private repositories. Only authorize apps you trust."
    }
  };

  const hasRepoScope = scopes.includes("repo");

  const hiddenInputs = Object.entries(hiddenFields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
    )
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${escapeHtml(clientName)} - uithub</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #000;
      color: #f0f0f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .consent-card {
      background: #1a1a1a;
      border-radius: 16px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .logo {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo h1 {
      font-size: 32px;
      font-weight: 800;
      background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin: 0;
    }
    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #2a2a2a;
      padding: 12px 16px;
      border-radius: 10px;
      margin-bottom: 24px;
    }
    .user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 2px solid #a855f7;
    }
    .user-details {
      flex: 1;
    }
    .user-label {
      font-size: 12px;
      color: #888;
      margin-bottom: 2px;
    }
    .user-name {
      font-weight: 600;
      color: #f0f0f0;
    }
    .client-section {
      text-align: center;
      margin-bottom: 24px;
    }
    .client-name {
      font-size: 24px;
      font-weight: 700;
      color: #f0f0f0;
      margin: 0 0 8px;
    }
    .client-wants {
      color: #888;
      font-size: 14px;
    }
    .permissions-section {
      margin-bottom: 24px;
    }
    .permissions-title {
      font-size: 14px;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .permission-item {
      background: #2a2a2a;
      padding: 14px 16px;
      border-radius: 10px;
      margin-bottom: 8px;
    }
    .permission-label {
      font-weight: 600;
      color: #f0f0f0;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .permission-icon {
      font-size: 16px;
    }
    .permission-description {
      font-size: 13px;
      color: #888;
      line-height: 1.4;
    }
    .warning-box {
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid rgba(234, 179, 8, 0.3);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 24px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .warning-icon {
      font-size: 20px;
      flex-shrink: 0;
    }
    .warning-text {
      font-size: 13px;
      color: #eab308;
      line-height: 1.4;
    }
    .redirect-info {
      background: #2a2a2a;
      padding: 12px 16px;
      border-radius: 10px;
      margin-bottom: 24px;
    }
    .redirect-label {
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
    }
    .redirect-uri {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      color: #a855f7;
      word-break: break-all;
    }
    .button-group {
      display: flex;
      gap: 12px;
    }
    .btn {
      flex: 1;
      padding: 14px 24px;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }
    .btn-allow {
      background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
      color: white;
    }
    .btn-allow:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(168, 85, 247, 0.3);
    }
    .btn-deny {
      background: #2a2a2a;
      color: #888;
      border: 1px solid #444;
    }
    .btn-deny:hover {
      background: #333;
      color: #f0f0f0;
    }
    .footer-note {
      text-align: center;
      margin-top: 20px;
      font-size: 12px;
      color: #666;
    }
    .footer-note a {
      color: #a855f7;
      text-decoration: none;
    }
    .footer-note a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="consent-card">
    <div class="logo">
      <h1>uithub</h1>
    </div>
    
    <div class="user-info">
      <img src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(user.login)}" class="user-avatar">
      <div class="user-details">
        <div class="user-label">Logged in as</div>
        <div class="user-name">@${escapeHtml(user.login)}</div>
      </div>
    </div>

    <div class="client-section">
      <h2 class="client-name">${escapeHtml(clientName)}</h2>
      <p class="client-wants">wants to access your uithub account</p>
    </div>

    <div class="permissions-section">
      <div class="permissions-title">This will allow the app to:</div>
      ${scopes
        .map((scope) => {
          const info = scopeDescriptions[scope] || {
            label: scope,
            description: `Access: ${scope}`
          };
          return `
      <div class="permission-item">
        <div class="permission-label">
          <span class="permission-icon">${scope === "repo" ? "🔒" : "📖"}</span>
          ${escapeHtml(info.label)}
        </div>
        <div class="permission-description">${escapeHtml(info.description)}</div>
      </div>`;
        })
        .join("")}
    </div>

    ${
      hasRepoScope
        ? `
    <div class="warning-box">
      <span class="warning-icon">⚠️</span>
      <span class="warning-text">
        This application is requesting access to your private repositories. Only authorize applications you trust.
      </span>
    </div>
    `
        : ""
    }

    <div class="redirect-info">
      <div class="redirect-label">After authorization, you'll be redirected to:</div>
      <div class="redirect-uri">${escapeHtml(redirectUri)}</div>
    </div>

    <form method="POST" action="${escapeHtml(formAction)}">
      ${hiddenInputs}
      <div class="button-group">
        <button type="submit" name="consent" value="deny" class="btn btn-deny">Deny</button>
        <button type="submit" name="consent" value="allow" class="btn btn-allow">Allow</button>
      </div>
    </form>

    <div class="footer-note">
      By authorizing, you agree to uithub's <a href="/tos.html">Terms of Service</a>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==================== OAUTH AUTHORIZATION ENDPOINT ====================

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Handle both GET (show consent) and POST (process consent)
  const isPost = request.method === "POST";

  let clientId: string | null;
  let redirectUri: string | null;
  let responseType: string | null;
  let scope: string;
  let state: string | null;
  let codeChallenge: string | null;
  let codeChallengeMethod: string;
  let resource: string | null;
  let consent: string | null = null;

  if (isPost) {
    const formData = await request.formData();
    clientId = formData.get("client_id")?.toString() || null;
    redirectUri = formData.get("redirect_uri")?.toString() || null;
    responseType = formData.get("response_type")?.toString() || null;
    scope = formData.get("scope")?.toString() || "read";
    state = formData.get("state")?.toString() || null;
    codeChallenge = formData.get("code_challenge")?.toString() || null;
    codeChallengeMethod =
      formData.get("code_challenge_method")?.toString() || "plain";
    resource = formData.get("resource")?.toString() || null;
    consent = formData.get("consent")?.toString() || null;
  } else {
    clientId = url.searchParams.get("client_id");
    redirectUri = url.searchParams.get("redirect_uri");
    responseType = url.searchParams.get("response_type");
    scope = url.searchParams.get("scope") || "read";
    state = url.searchParams.get("state");
    codeChallenge = url.searchParams.get("code_challenge");
    codeChallengeMethod =
      url.searchParams.get("code_challenge_method") || "plain";
    resource = url.searchParams.get("resource");
  }

  if (!clientId || !redirectUri || responseType !== "code") {
    return new Response("Invalid authorization request", { status: 400 });
  }

  const client = await getRegisteredClient(clientId, env);
  if (!client) {
    return new Response("Unknown client", { status: 400 });
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    return new Response("Invalid redirect_uri", { status: 400 });
  }

  const session = getSessionFromCookie(request);

  // User is logged in
  if (session.accessToken && session.user) {
    // Handle POST - user made a choice
    if (isPost) {
      // User denied access - redirect to homepage
      if (consent === "deny") {
        return Response.redirect(url.origin, 302);
      }

      // User allowed access - create auth code and redirect
      if (consent === "allow") {
        const code = generateRandomString(32);
        const authCode: AuthorizationCode = {
          code,
          client_id: clientId,
          redirect_uri: redirectUri,
          user_id: String(session.user.id),
          github_access_token: session.accessToken,
          scopes: scope,
          code_challenge: codeChallenge || undefined,
          code_challenge_method: codeChallenge
            ? codeChallengeMethod
            : undefined,
          expires_at: Date.now() + 600000,
          resource: resource || undefined
        };
        await storeAuthorizationCode(authCode, env);

        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set("code", code);
        if (state) redirectUrl.searchParams.set("state", state);

        return Response.redirect(redirectUrl.toString(), 302);
      }
    }

    // GET request - show consent screen
    const scopes = scope.split(/[\s,]+/).filter((s) => s);
    const html = generateConsentScreenHTML({
      clientName: client.client_name,
      clientId: client.client_id,
      redirectUri,
      scopes,
      user: session.user,
      formAction: "/authorize",
      hiddenFields: {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: responseType,
        scope,
        ...(state && { state }),
        ...(codeChallenge && { code_challenge: codeChallenge }),
        ...(codeChallenge && { code_challenge_method: codeChallengeMethod }),
        ...(resource && { resource })
      }
    });

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "X-XSS-Protection": "1; mode=block",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
      }
    });
  }

  // User not logged in - redirect to GitHub OAuth
  const githubScope = scope.includes("repo") ? "repo" : "user:email";
  const codeVerifier = generateCodeVerifier();
  const githubCodeChallenge = await generateCodeChallenge(codeVerifier);

  const oauthState: OAuthState = {
    codeVerifier,
    scope: githubScope,
    clientId,
    clientRedirectUri: redirectUri,
    clientState: state || undefined,
    codeChallenge: codeChallenge || undefined,
    codeChallengeMethod: codeChallenge ? codeChallengeMethod : undefined,
    resource: resource || undefined
  };

  const stateString = btoa(JSON.stringify(oauthState));
  const isLocalhost = url.hostname === "localhost";

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
  githubUrl.searchParams.set("scope", githubScope);
  githubUrl.searchParams.set("state", stateString);
  githubUrl.searchParams.set("code_challenge", githubCodeChallenge);
  githubUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: githubUrl.toString(),
      "Set-Cookie": `oauth_state=${encodeURIComponent(stateString)}; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=600; Path=/`
    }
  });
}

// ==================== OAUTH TOKEN ENDPOINT ====================

async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return withCors(new Response("Method not allowed", { status: 405 }));
  }

  const contentType = request.headers.get("Content-Type") || "";
  let body: Record<string, string> = {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    params.forEach((value, key) => {
      body[key] = value;
    });
  } else if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    return withCors(
      Response.json(
        {
          error: "invalid_request",
          error_description: "Unsupported content type"
        },
        { status: 400 }
      )
    );
  }

  const grantType = body.grant_type;

  if (grantType !== "authorization_code") {
    return withCors(
      Response.json({ error: "unsupported_grant_type" }, { status: 400 })
    );
  }

  const code = body.code;
  const redirectUri = body.redirect_uri;
  const clientId = body.client_id;
  const clientSecret = body.client_secret;
  const codeVerifier = body.code_verifier;

  if (!code || !redirectUri || !clientId) {
    return withCors(
      Response.json(
        {
          error: "invalid_request",
          error_description: "Missing required parameters"
        },
        { status: 400 }
      )
    );
  }

  const client = await getRegisteredClient(clientId, env);
  if (!client) {
    return withCors(
      Response.json({ error: "invalid_client" }, { status: 401 })
    );
  }

  if (clientSecret && client.client_secret !== clientSecret) {
    return withCors(
      Response.json({ error: "invalid_client" }, { status: 401 })
    );
  }

  const authCode = await getAuthorizationCode(code, env);
  if (!authCode) {
    return withCors(
      Response.json(
        {
          error: "invalid_grant",
          error_description: "Invalid or expired code"
        },
        { status: 400 }
      )
    );
  }

  if (authCode.client_id !== clientId) {
    return withCors(
      Response.json(
        { error: "invalid_grant", error_description: "Client mismatch" },
        { status: 400 }
      )
    );
  }

  if (authCode.redirect_uri !== redirectUri) {
    return withCors(
      Response.json(
        { error: "invalid_grant", error_description: "Redirect URI mismatch" },
        { status: 400 }
      )
    );
  }

  if (Date.now() > authCode.expires_at) {
    await deleteAuthorizationCode(code, env);
    return withCors(
      Response.json(
        { error: "invalid_grant", error_description: "Code expired" },
        { status: 400 }
      )
    );
  }

  if (authCode.code_challenge) {
    if (!codeVerifier) {
      return withCors(
        Response.json(
          {
            error: "invalid_grant",
            error_description: "code_verifier required"
          },
          { status: 400 }
        )
      );
    }
    const valid = await verifyCodeChallenge(
      codeVerifier,
      authCode.code_challenge,
      authCode.code_challenge_method || "plain"
    );
    if (!valid) {
      return withCors(
        Response.json(
          {
            error: "invalid_grant",
            error_description: "Invalid code_verifier"
          },
          { status: 400 }
        )
      );
    }
  }

  await deleteAuthorizationCode(code, env);

  const accessToken = generateRandomString(32);
  const tokenData: AccessToken = {
    token: accessToken,
    client_id: clientId,
    user_id: authCode.user_id,
    github_access_token: authCode.github_access_token,
    scopes: authCode.scopes,
    expires_at: Date.now() + 86400000,
    resource: authCode.resource
  };

  await storeAccessToken(tokenData, env);

  // Store client access for dashboard display
  const clientAccessKey = `user_client_access_${authCode.user_id}`;
  const existingAccess =
    ((await env.KV.get(clientAccessKey, "json")) as ClientAccess[]) || [];
  const existingIndex = existingAccess.findIndex(
    (c) => c.client_id === clientId
  );

  if (existingIndex !== -1) {
    // Update existing entry
    existingAccess[existingIndex].last_used = Date.now();
    existingAccess[existingIndex].scopes = authCode.scopes;
  } else {
    // Add new entry
    existingAccess.push({
      client_id: clientId,
      client_name: client.client_name,
      created_at: Date.now(),
      scopes: authCode.scopes
    });
  }

  await env.KV.put(clientAccessKey, JSON.stringify(existingAccess));

  return withCors(
    Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
      scope: authCode.scopes
    })
  );
}

// ==================== BROWSER LOGIN FLOW ====================

async function handleBrowserLogin(
  request: Request,
  env: Env,
  scope: string
): Promise<Response> {
  const url = new URL(request.url);
  const isLocalhost = url.hostname === "localhost";
  const redirectTo = url.searchParams.get("redirect_to") || "/";
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const resource = url.searchParams.get("resource");

  const state: OAuthState = {
    redirectTo,
    codeVerifier,
    scope,
    resource: resource || undefined
  };
  const stateString = btoa(JSON.stringify(state));

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
  githubUrl.searchParams.set("scope", scope);
  githubUrl.searchParams.set("state", stateString);
  githubUrl.searchParams.set("code_challenge", codeChallenge);
  githubUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: githubUrl.toString(),
      "Set-Cookie": `oauth_state=${encodeURIComponent(stateString)}; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=600; Path=/`
    }
  });
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const stateCookie = cookies.oauth_state;

  if (!stateCookie || stateCookie !== stateParam) {
    return new Response("Invalid state parameter", { status: 400 });
  }

  let state: OAuthState;
  try {
    state = JSON.parse(atob(stateParam));
  } catch {
    return new Response("Invalid state format", { status: 400 });
  }

  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/callback`,
        code_verifier: state.codeVerifier
      })
    }
  );

  const tokenData = (await tokenResponse.json()) as any;
  if (!tokenData.access_token) {
    return new Response("Failed to get access token", { status: 400 });
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "uithub"
    }
  });

  if (!userResponse.ok) {
    return new Response("Failed to get user info", { status: 400 });
  }

  const userData = (await userResponse.json()) as any;
  const grantedScopes = userResponse.headers.get("X-OAuth-Scopes") || "";

  await createOrUpdateUser(
    String(userData.id),
    {
      username: userData.login,
      profile_picture: userData.avatar_url
    },
    env
  );

  if (grantedScopes.includes("repo")) {
    const account = await getUserAccount(String(userData.id), env);
    if (account) {
      account.private_granted = true;
      await setUserAccount(String(userData.id), account, env);
    }
  }

  const isLocalhost = url.hostname === "localhost";

  if (state.clientId && state.clientRedirectUri) {
    // Create session and redirect to /authorize to show consent screen
    const sessionData = {
      user: userData,
      accessToken: tokenData.access_token,
      scopes: grantedScopes,
      exp: Date.now() + 7 * 24 * 3600 * 1000
    };
    const sessionToken = btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(sessionData)))
    );

    // Build the authorize URL with all original OAuth params
    const authorizeUrl = new URL(`${url.origin}/authorize`);
    authorizeUrl.searchParams.set("client_id", state.clientId);
    authorizeUrl.searchParams.set("redirect_uri", state.clientRedirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", state.scope);
    if (state.clientState) {
      authorizeUrl.searchParams.set("state", state.clientState);
    }
    if (state.codeChallenge) {
      authorizeUrl.searchParams.set("code_challenge", state.codeChallenge);
    }
    if (state.codeChallengeMethod) {
      authorizeUrl.searchParams.set(
        "code_challenge_method",
        state.codeChallengeMethod
      );
    }
    if (state.resource) {
      authorizeUrl.searchParams.set("resource", state.resource);
    }

    const headers = new Headers({ Location: authorizeUrl.toString() });
    headers.append(
      "Set-Cookie",
      `oauth_state=; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=0; Path=/`
    );
    headers.append(
      "Set-Cookie",
      `session=${sessionToken}; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}; Path=/`
    );

    return new Response(null, { status: 302, headers });
  }

  const sessionData = {
    user: userData,
    accessToken: tokenData.access_token,
    scopes: grantedScopes,
    exp: Date.now() + 7 * 24 * 3600 * 1000
  };
  const sessionToken = btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(sessionData)))
  );

  const headers = new Headers({ Location: state.redirectTo || "/" });
  headers.append(
    "Set-Cookie",
    `oauth_state=; HttpOnly;${
      isLocalhost ? "" : " Secure;"
    } SameSite=Lax; Max-Age=0; Path=/`
  );
  headers.append(
    "Set-Cookie",
    `session=${sessionToken}; HttpOnly;${
      isLocalhost ? "" : " Secure;"
    } SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}; Path=/`
  );

  return new Response(null, { status: 302, headers });
}

function handleLogout(request: Request): Response {
  const url = new URL(request.url);
  const isLocalhost = url.hostname === "localhost";
  const redirectTo = url.searchParams.get("redirect_to") || "/";
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": `session=; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=0; Path=/`
    }
  });
}

// ==================== WWW-AUTHENTICATE HELPER ====================

export function createWWWAuthenticateHeader(url: URL): string {
  return (
    `Bearer realm="${url.hostname}", ` +
    `resource_metadata="${url.origin}/.well-known/oauth-protected-resource", ` +
    `scope="read repo"`
  );
}

export function createUnauthorizedResponse(url: URL): Response {
  return new Response("Unauthorized. Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": createWWWAuthenticateHeader(url),
      "Content-Type": "text/plain"
    }
  });
}

// ==================== MAIN AUTH MIDDLEWARE ====================

export async function authMiddleware(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);

  // Handle CORS preflight for OAuth endpoints
  if (request.method === "OPTIONS") {
    if (
      url.pathname === "/register" ||
      url.pathname === "/token" ||
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return handleCorsPreflightRequest();
    }
  }

  // Well-known endpoints
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return handleOAuthProtectedResource(url);
  }

  if (
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/.well-known/openid-configuration"
  ) {
    return handleOAuthAuthorizationServer(url);
  }

  // OAuth endpoints
  if (url.pathname === "/register") {
    return handleClientRegistration(request, env);
  }

  if (url.pathname === "/authorize") {
    return handleAuthorize(request, env);
  }

  if (url.pathname === "/token") {
    return handleToken(request, env);
  }

  // Browser login flow
  if (url.pathname === "/login") {
    const scope = url.searchParams.get("scope") || "user:email";
    return handleBrowserLogin(request, env, scope);
  }

  if (url.pathname === "/callback") {
    return handleCallback(request, env);
  }

  if (url.pathname === "/logout") {
    return handleLogout(request);
  }

  return null;
}

export const getUser = async (request: Request, env: Env) => {
  const bearerToken = getBearerToken(request);
  const session = getSessionFromCookie(request);

  let githubAccessToken: string | null = null;
  let currentUser: { id: number; login: string; avatar_url: string } | null =
    null;
  let sessionScopes: string = "";

  if (bearerToken) {
    // Check for dashboard-created API keys (uitk_ prefix)
    if (bearerToken.startsWith("uitk_")) {
      const userId = await env.KV.get(`api_key_${bearerToken}`);
      if (userId) {
        const userAccount = await getUserAccount(userId, env);
        if (userAccount) {
          currentUser = {
            id: parseInt(userId),
            login: userAccount.username,
            avatar_url: userAccount.profile_picture
          };
          sessionScopes = userAccount.private_granted ? "repo" : "read";
          // Update last_used timestamp for the API key
          const apiKeys =
            ((await env.KV.get(`user_api_keys_${userId}`, "json")) as any[]) ||
            [];
          const keyIndex = apiKeys.findIndex((k: any) => k.key === bearerToken);
          if (keyIndex !== -1) {
            apiKeys[keyIndex].last_used = Date.now();
            await env.KV.put(
              `user_api_keys_${userId}`,
              JSON.stringify(apiKeys)
            );
          }
        }
      }
    } else {
      // OAuth access token
      const tokenData = await getAccessTokenData(bearerToken, env);
      if (tokenData && Date.now() < tokenData.expires_at) {
        githubAccessToken = tokenData.github_access_token;
        const userResponse = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${githubAccessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "uithub"
          }
        });
        if (userResponse.ok) {
          currentUser = await userResponse.json();
          sessionScopes = tokenData.scopes;
        }
      }
    }
  } else if (session.accessToken) {
    githubAccessToken = session.accessToken;
    currentUser = session.user;
    sessionScopes = session.scopes;
  }
  return { githubAccessToken, currentUser, sessionScopes };
};
