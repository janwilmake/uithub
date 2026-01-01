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
  KV: KVNamespace;
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
  env: Env,
): Promise<RegisteredClient | null> {
  const data = await env.KV.get(`client_${clientId}`, "json");
  return data as RegisteredClient | null;
}

async function setRegisteredClient(
  client: RegisteredClient,
  env: Env,
): Promise<void> {
  await env.KV.put(`client_${client.client_id}`, JSON.stringify(client));
}

async function storeAuthorizationCode(
  code: AuthorizationCode,
  env: Env,
): Promise<void> {
  await env.KV.put(`auth_code_${code.code}`, JSON.stringify(code), {
    expirationTtl: 600, // 10 minutes
  });
}

async function getAuthorizationCode(
  code: string,
  env: Env,
): Promise<AuthorizationCode | null> {
  const data = await env.KV.get(`auth_code_${code}`, "json");
  return data as AuthorizationCode | null;
}

async function deleteAuthorizationCode(code: string, env: Env): Promise<void> {
  await env.KV.delete(`auth_code_${code}`);
}

async function storeAccessToken(token: AccessToken, env: Env): Promise<void> {
  await env.KV.put(`access_token_${token.token}`, JSON.stringify(token), {
    expirationTtl: 86400, // 24 hours
  });
}

export async function getAccessTokenData(
  token: string,
  env: Env,
): Promise<AccessToken | null> {
  const data = await env.KV.get(`access_token_${token}`, "json");
  return data as AccessToken | null;
}

export async function getUserAccount(
  userId: string,
  env: Env,
): Promise<UserAccount | null> {
  const data = await env.KV.get(`user_${userId}`, "json");
  return data as UserAccount | null;
}

export async function setUserAccount(
  userId: string,
  account: UserAccount,
  env: Env,
): Promise<void> {
  await env.KV.put(`user_${userId}`, JSON.stringify(account));
}

export async function createOrUpdateUser(
  userId: string,
  userData: { username: string; profile_picture: string },
  env: Env,
): Promise<UserAccount> {
  const existing = await getUserAccount(userId, env);
  if (existing) {
    const updated = {
      ...existing,
      username: userData.username,
      profile_picture: userData.profile_picture,
    };
    await setUserAccount(userId, updated, env);
    return updated;
  }

  const newAccount: UserAccount = {
    credit: 0,
    username: userData.username,
    profile_picture: userData.profile_picture,
    private_granted: false,
    premium: false,
  };
  await setUserAccount(userId, newAccount, env);
  return newAccount;
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
    String.fromCharCode.apply(null, Array.from(new Uint8Array(digest))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function verifyCodeChallenge(
  verifier: string,
  challenge: string,
  method: string,
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
    const sessionData = JSON.parse(atob(sessionToken));
    if (Date.now() > sessionData.exp)
      return { accessToken: null, user: null, scopes: "" };
    return {
      accessToken: sessionData.accessToken,
      user: sessionData.user,
      scopes: sessionData.scopes || "",
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
  return Response.json({
    resource: url.origin,
    authorization_servers: [url.origin],
  });
}

function handleOAuthAuthorizationServer(url: URL): Response {
  return Response.json({
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
      "client_secret_basic",
    ],
  });
}

// ==================== DYNAMIC CLIENT REGISTRATION ====================

async function handleClientRegistration(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { redirect_uris, client_name } = body;

  if (
    !redirect_uris ||
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0
  ) {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uris required" },
      { status: 400 },
    );
  }

  const clientId = `client_${generateRandomString(16)}`;
  const clientSecret = generateRandomString(32);

  const client: RegisteredClient = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris,
    client_name: client_name || "Unknown Client",
    created_at: Date.now(),
  };

  await setRegisteredClient(client, env);

  return Response.json({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris,
    client_name: client.client_name,
    token_endpoint_auth_method: "client_secret_post",
  });
}

// ==================== OAUTH AUTHORIZATION ENDPOINT ====================

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const responseType = url.searchParams.get("response_type");
  const scope = url.searchParams.get("scope") || "read";
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod =
    url.searchParams.get("code_challenge_method") || "plain";
  const resource = url.searchParams.get("resource");

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
  if (session.accessToken && session.user) {
    const code = generateRandomString(32);
    const authCode: AuthorizationCode = {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      user_id: String(session.user.id),
      github_access_token: session.accessToken,
      scopes: scope,
      code_challenge: codeChallenge || undefined,
      code_challenge_method: codeChallenge ? codeChallengeMethod : undefined,
      expires_at: Date.now() + 600000,
      resource: resource || undefined,
    };
    await storeAuthorizationCode(authCode, env);

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    return Response.redirect(redirectUrl.toString(), 302);
  }

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
    resource: resource || undefined,
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
      } SameSite=Lax; Max-Age=600; Path=/`,
    },
  });
}

// ==================== OAUTH TOKEN ENDPOINT ====================

async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
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
    return Response.json(
      {
        error: "invalid_request",
        error_description: "Unsupported content type",
      },
      { status: 400 },
    );
  }

  const grantType = body.grant_type;

  if (grantType !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const code = body.code;
  const redirectUri = body.redirect_uri;
  const clientId = body.client_id;
  const clientSecret = body.client_secret;
  const codeVerifier = body.code_verifier;

  if (!code || !redirectUri || !clientId) {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "Missing required parameters",
      },
      { status: 400 },
    );
  }

  const client = await getRegisteredClient(clientId, env);
  if (!client) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }

  if (clientSecret && client.client_secret !== clientSecret) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }

  const authCode = await getAuthorizationCode(code, env);
  if (!authCode) {
    return Response.json(
      { error: "invalid_grant", error_description: "Invalid or expired code" },
      { status: 400 },
    );
  }

  if (authCode.client_id !== clientId) {
    return Response.json(
      { error: "invalid_grant", error_description: "Client mismatch" },
      { status: 400 },
    );
  }

  if (authCode.redirect_uri !== redirectUri) {
    return Response.json(
      { error: "invalid_grant", error_description: "Redirect URI mismatch" },
      { status: 400 },
    );
  }

  if (Date.now() > authCode.expires_at) {
    await deleteAuthorizationCode(code, env);
    return Response.json(
      { error: "invalid_grant", error_description: "Code expired" },
      { status: 400 },
    );
  }

  if (authCode.code_challenge) {
    if (!codeVerifier) {
      return Response.json(
        { error: "invalid_grant", error_description: "code_verifier required" },
        { status: 400 },
      );
    }
    const valid = await verifyCodeChallenge(
      codeVerifier,
      authCode.code_challenge,
      authCode.code_challenge_method || "plain",
    );
    if (!valid) {
      return Response.json(
        { error: "invalid_grant", error_description: "Invalid code_verifier" },
        { status: 400 },
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
    resource: authCode.resource,
  };

  await storeAccessToken(tokenData, env);

  // Store client access for dashboard display
  const clientAccessKey = `user_client_access_${authCode.user_id}`;
  const existingAccess =
    ((await env.KV.get(clientAccessKey, "json")) as ClientAccess[]) || [];
  const existingIndex = existingAccess.findIndex(
    (c) => c.client_id === clientId,
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
      scopes: authCode.scopes,
    });
  }

  await env.KV.put(clientAccessKey, JSON.stringify(existingAccess));

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 86400,
    scope: authCode.scopes,
  });
}

// ==================== BROWSER LOGIN FLOW ====================

async function handleBrowserLogin(
  request: Request,
  env: Env,
  scope: string,
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
    resource: resource || undefined,
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
      } SameSite=Lax; Max-Age=600; Path=/`,
    },
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
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/callback`,
        code_verifier: state.codeVerifier,
      }),
    },
  );

  const tokenData = (await tokenResponse.json()) as any;
  if (!tokenData.access_token) {
    return new Response("Failed to get access token", { status: 400 });
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "uithub",
    },
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
      profile_picture: userData.avatar_url,
    },
    env,
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
    const authCode = generateRandomString(32);
    const authCodeData: AuthorizationCode = {
      code: authCode,
      client_id: state.clientId,
      redirect_uri: state.clientRedirectUri,
      user_id: String(userData.id),
      github_access_token: tokenData.access_token,
      scopes: state.scope,
      code_challenge: state.codeChallenge,
      code_challenge_method: state.codeChallengeMethod,
      expires_at: Date.now() + 600000,
      resource: state.resource,
    };
    await storeAuthorizationCode(authCodeData, env);

    const redirectUrl = new URL(state.clientRedirectUri);
    redirectUrl.searchParams.set("code", authCode);
    if (state.clientState) {
      redirectUrl.searchParams.set("state", state.clientState);
    }

    const sessionData = {
      user: userData,
      accessToken: tokenData.access_token,
      scopes: grantedScopes,
      exp: Date.now() + 7 * 24 * 3600 * 1000,
    };
    const sessionToken = btoa(JSON.stringify(sessionData));

    const headers = new Headers({ Location: redirectUrl.toString() });
    headers.append(
      "Set-Cookie",
      `oauth_state=; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=0; Path=/`,
    );
    headers.append(
      "Set-Cookie",
      `session=${sessionToken}; HttpOnly;${
        isLocalhost ? "" : " Secure;"
      } SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}; Path=/`,
    );

    return new Response(null, { status: 302, headers });
  }

  const sessionData = {
    user: userData,
    accessToken: tokenData.access_token,
    scopes: grantedScopes,
    exp: Date.now() + 7 * 24 * 3600 * 1000,
  };
  const sessionToken = btoa(JSON.stringify(sessionData));

  const headers = new Headers({ Location: state.redirectTo || "/" });
  headers.append(
    "Set-Cookie",
    `oauth_state=; HttpOnly;${
      isLocalhost ? "" : " Secure;"
    } SameSite=Lax; Max-Age=0; Path=/`,
  );
  headers.append(
    "Set-Cookie",
    `session=${sessionToken}; HttpOnly;${
      isLocalhost ? "" : " Secure;"
    } SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}; Path=/`,
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
      } SameSite=Lax; Max-Age=0; Path=/`,
    },
  });
}

// ==================== WWW-AUTHENTICATE HELPER ====================

export function createWWWAuthenticateHeader(
  url: URL,
  scope: string = "read",
): string {
  return (
    `Bearer realm="${url.hostname}", ` +
    `resource_metadata="${url.origin}/.well-known/oauth-protected-resource", ` +
    `scope="${scope}"`
  );
}

export function createUnauthorizedResponse(
  url: URL,
  scope: string = "read",
): Response {
  return new Response("Unauthorized. Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": createWWWAuthenticateHeader(url, scope),
      "Content-Type": "text/plain",
    },
  });
}

// ==================== MAIN AUTH MIDDLEWARE ====================

export async function authMiddleware(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

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
  if (url.pathname === "/register" && request.method === "POST") {
    return handleClientRegistration(request, env);
  }

  if (url.pathname === "/authorize") {
    return handleAuthorize(request, env);
  }

  if (url.pathname === "/token" && request.method === "POST") {
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
  let currentUser: any = null;
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
            avatar_url: userAccount.profile_picture,
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
              JSON.stringify(apiKeys),
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
            "User-Agent": "uithub",
          },
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
