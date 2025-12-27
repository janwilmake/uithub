import { parse as parseYaml } from "yaml";
import { Stripe } from "stripe";

type ContentType = {
  type: "content" | "binary";
  content?: string;
  url?: string;
  hash: string;
  size: number;
};

type NestedObject<T = null> = {
  [key: string]: NestedObject<T> | T;
};

interface CompiledGitignore {
  accepts: (input: string) => boolean;
  denies: (input: string) => boolean;
}

interface UserAccount {
  credit: number; // in cents
  username: string;
  profile_picture: string;
  private_granted: boolean;
  premium: boolean;
}

interface RegisteredClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string;
  created_at: number;
}

interface AuthorizationCode {
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

interface AccessToken {
  token: string;
  client_id: string;
  user_id: string;
  github_access_token: string;
  scopes: string;
  expires_at: number;
  resource?: string;
}

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  STRIPE_SECRET: string;
  STRIPE_PAYMENT_LINK: string;
  STRIPE_PAYMENT_LINK_ID: string;
  STRIPE_WEBHOOK_SIGNING_SECRET: string;
  KV: KVNamespace;
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

// ==================== CONSTANTS ====================

const CHARACTERS_PER_TOKEN = 5;
const DEFAULT_MAX_TOKENS = 50000;
const PRIVATE_REPO_COST_CENTS = 1; // $0.01
const DEFAULT_GENIGNORE = `package-lock.json
build
node_modules
`;

// ZIP signatures
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIR_HEADER = 0x02014b50;

// ==================== KV HELPERS ====================

async function getUserAccount(
  userId: string,
  env: Env,
): Promise<UserAccount | null> {
  const data = await env.KV.get(`user_${userId}`, "json");
  return data as UserAccount | null;
}

async function setUserAccount(
  userId: string,
  account: UserAccount,
  env: Env,
): Promise<void> {
  await env.KV.put(`user_${userId}`, JSON.stringify(account));
}

async function createOrUpdateUser(
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

async function chargeForPrivateRepo(
  userId: string,
  env: Env,
): Promise<{ success: boolean; message: string }> {
  const account = await getUserAccount(userId, env);
  if (!account) {
    return { success: false, message: "Account not found" };
  }
  if (account.credit < PRIVATE_REPO_COST_CENTS) {
    return { success: false, message: "Insufficient credit" };
  }
  account.credit -= PRIVATE_REPO_COST_CENTS;
  await setUserAccount(userId, account, env);
  return { success: true, message: "Charged successfully" };
}

// Client registration helpers
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

// Authorization code helpers
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

// Access token helpers
async function storeAccessToken(token: AccessToken, env: Env): Promise<void> {
  await env.KV.put(`access_token_${token.token}`, JSON.stringify(token), {
    expirationTtl: 86400, // 24 hours
  });
}

async function getAccessTokenData(
  token: string,
  env: Env,
): Promise<AccessToken | null> {
  const data = await env.KV.get(`access_token_${token}`, "json");
  return data as AccessToken | null;
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

function getSessionFromCookie(request: Request): {
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

function getBearerToken(request: Request): string | null {
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

  // Validate required parameters
  if (!clientId || !redirectUri || responseType !== "code") {
    return new Response("Invalid authorization request", { status: 400 });
  }

  // Validate client
  const client = await getRegisteredClient(clientId, env);
  if (!client) {
    return new Response("Unknown client", { status: 400 });
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    return new Response("Invalid redirect_uri", { status: 400 });
  }

  // Check if user is already logged in via session cookie
  const session = getSessionFromCookie(request);
  if (session.accessToken && session.user) {
    // User is already authenticated, generate authorization code
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

  // Need to authenticate with GitHub first
  // Store OAuth parameters in state to resume after GitHub auth
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

  // Validate client
  const client = await getRegisteredClient(clientId, env);
  if (!client) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }

  // Validate client secret if provided
  if (clientSecret && client.client_secret !== clientSecret) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }

  // Get and validate authorization code
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

  // Validate PKCE if code challenge was provided
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

  // Delete used authorization code
  await deleteAuthorizationCode(code, env);

  // Generate access token
  const accessToken = generateRandomString(32);
  const tokenData: AccessToken = {
    token: accessToken,
    client_id: clientId,
    user_id: authCode.user_id,
    github_access_token: authCode.github_access_token,
    scopes: authCode.scopes,
    expires_at: Date.now() + 86400000, // 24 hours
    resource: authCode.resource,
  };

  await storeAccessToken(tokenData, env);

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

  // Exchange code for GitHub access token
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

  // Get user info from GitHub
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

  // Create or update user in KV
  await createOrUpdateUser(
    String(userData.id),
    {
      username: userData.login,
      profile_picture: userData.avatar_url,
    },
    env,
  );

  // Update private_granted if repo scope was granted
  if (grantedScopes.includes("repo")) {
    const account = await getUserAccount(String(userData.id), env);
    if (account) {
      account.private_granted = true;
      await setUserAccount(String(userData.id), account, env);
    }
  }

  const isLocalhost = url.hostname === "localhost";

  // Check if this is an OAuth client flow
  if (state.clientId && state.clientRedirectUri) {
    // Generate authorization code for the client
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

    // Also set browser session cookie
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

  // Browser-only flow - set session cookie and redirect
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

async function handleLogout(request: Request): Promise<Response> {
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

// ==================== STRIPE WEBHOOK HANDLER ====================

const streamToBuffer = async (
  readableStream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = readableStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
};

async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!request.body) {
    return Response.json({ error: "No body" }, { status: 400 });
  }

  const rawBody = await streamToBuffer(request.body);
  const rawBodyString = new TextDecoder().decode(rawBody);

  const stripe = new Stripe(env.STRIPE_SECRET, {
    apiVersion: "2025-11-17.clover",
  });

  const stripeSignature = request.headers.get("stripe-signature");
  if (!stripeSignature) {
    return Response.json({ error: "No signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBodyString,
      stripeSignature,
      env.STRIPE_WEBHOOK_SIGNING_SECRET,
    );
  } catch (err: any) {
    console.log("Webhook error:", err.message);
    return new Response(`Webhook error: ${String(err)}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.payment_link !== env.STRIPE_PAYMENT_LINK_ID) {
      return new Response("Incorrect payment link", { status: 400 });
    }

    if (session.payment_status !== "paid" || !session.amount_subtotal) {
      return new Response("Payment not completed", { status: 400 });
    }

    const { client_reference_id, amount_subtotal } = session;

    if (!client_reference_id) {
      return new Response("Missing client_reference_id", { status: 400 });
    }

    const userId = client_reference_id;
    const account = await getUserAccount(userId, env);

    if (account) {
      account.credit += amount_subtotal;
      await setUserAccount(userId, account, env);
    } else {
      const newAccount: UserAccount = {
        credit: amount_subtotal,
        username: "",
        profile_picture: "",
        private_granted: false,
        premium: false,
      };
      await setUserAccount(userId, newAccount, env);
    }

    return new Response("Payment processed successfully", { status: 200 });
  }

  return new Response("Event not handled", { status: 200 });
}

// ==================== UTILITY FUNCTIONS ====================

function escapeHTML(str: string): string {
  if (typeof str !== "string") return "";
  return str
    .replace(
      /[&<>'"]/g,
      (tag) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        }[tag] || tag),
    )
    .replace(/\u0000/g, "\uFFFD")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function filePathToNestedObject<T, U>(
  flatObject: { [filepath: string]: T },
  mapper: (value: T) => U,
): NestedObject<U> {
  const result: NestedObject<U> = {};
  for (const [path, value] of Object.entries(flatObject)) {
    let parts = path.split("/");
    parts = parts[0] === "" ? parts.slice(1) : parts;
    let current: NestedObject<U> = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = mapper(value);
      } else {
        current[part] = (current[part] as NestedObject<U>) || {};
        current = current[part] as NestedObject<U>;
      }
    }
  }
  return result;
}

function nestedObjectToTreeString<T>(
  obj: NestedObject<T>,
  prefix: string = "",
  isLast: boolean = true,
): string {
  let result = "";
  const entries = Object.entries(obj);
  entries.forEach(([key, value], index) => {
    const isLastEntry = index === entries.length - 1;
    const newPrefix = prefix + (isLast ? "    " : "│   ");
    result += `${prefix}${isLastEntry ? "└── " : "├── "}${key}\n`;
    if (typeof value === "object" && value !== null) {
      result += nestedObjectToTreeString(
        value as NestedObject<T>,
        newPrefix,
        isLastEntry,
      );
    }
  });
  return result;
}

// ==================== GITIGNORE PARSER ====================

function escapeRegex(pattern: string): string {
  return pattern.replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, "\\$&");
}

function prepareRegexPattern(pattern: string): string {
  return escapeRegex(pattern).replace("**", "(.+)").replace("*", "([^\\/]+)");
}

function createRegExp(patterns: string[]): RegExp {
  return patterns.length > 0
    ? new RegExp(`^((${patterns.join(")|(")}))`)
    : new RegExp("$^");
}

function parseGitignore(content: string): {
  positives: RegExp;
  negatives: RegExp;
} {
  const lists: [string[], string[]] = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line[0] !== "#")
    .reduce(
      (lists, line) => {
        const isNegative = line[0] === "!";
        if (isNegative) line = line.slice(1);
        if (line[0] === "/") line = line.slice(1);
        lists[isNegative ? 1 : 0].push(line);
        return lists;
      },
      [[], []] as [string[], string[]],
    );
  return {
    positives: createRegExp(lists[0].sort().map(prepareRegexPattern)),
    negatives: createRegExp(lists[1].sort().map(prepareRegexPattern)),
  };
}

function compileGitignore(content: string): CompiledGitignore {
  const { positives, negatives } = parseGitignore(content);
  const checkInput = (input: string): string =>
    input[0] === "/" ? input.slice(1) : input;
  return {
    accepts: (input: string): boolean => {
      input = checkInput(input);
      return negatives.test(input) || !positives.test(input);
    },
    denies: (input: string): boolean => {
      input = checkInput(input);
      return !(negatives.test(input) || !positives.test(input));
    },
  };
}

// ==================== STREAMING ZIP PARSER ====================

class StreamingZipReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private done: boolean = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async ensureBytes(needed: number): Promise<boolean> {
    while (this.buffer.length < needed && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      const newBuffer = new Uint8Array(this.buffer.length + value.length);
      newBuffer.set(this.buffer, 0);
      newBuffer.set(value, this.buffer.length);
      this.buffer = newBuffer;
    }
    return this.buffer.length >= needed;
  }

  private consume(bytes: number): Uint8Array {
    const result = this.buffer.slice(0, bytes);
    this.buffer = this.buffer.slice(bytes);
    return result;
  }

  private readUint16(offset: number = 0): number {
    return this.buffer[offset] | (this.buffer[offset + 1] << 8);
  }

  private readUint32(offset: number = 0): number {
    return (
      this.buffer[offset] |
      (this.buffer[offset + 1] << 8) |
      (this.buffer[offset + 2] << 16) |
      (this.buffer[offset + 3] << 24)
    );
  }

  async *entries(): AsyncGenerator<{
    fileName: string;
    getData: () => Promise<Uint8Array | null>;
  }> {
    while (true) {
      if (!(await this.ensureBytes(4))) break;

      const signature = this.readUint32(0);

      if (signature === CENTRAL_DIR_HEADER || signature !== LOCAL_FILE_HEADER) {
        break;
      }

      if (!(await this.ensureBytes(30))) break;

      const compressionMethod = this.readUint16(8);
      const compressedSize = this.readUint32(18);
      const fileNameLength = this.readUint16(26);
      const extraFieldLength = this.readUint16(28);

      if (!(await this.ensureBytes(30 + fileNameLength))) break;

      const fileName = new TextDecoder().decode(
        this.buffer.slice(30, 30 + fileNameLength),
      );

      const headerSize = 30 + fileNameLength + extraFieldLength;

      if (!(await this.ensureBytes(headerSize))) break;

      this.consume(headerSize);

      const generalPurposeFlag =
        this.buffer.length >= 6 ? this.readUint16(6 - headerSize) : 0;
      const hasDataDescriptor = (generalPurposeFlag & 0x08) !== 0;

      if (fileName.endsWith("/")) {
        yield {
          fileName,
          getData: async () => null,
        };
        continue;
      }

      const currentCompressedSize = compressedSize;

      yield {
        fileName,
        getData: async (): Promise<Uint8Array | null> => {
          if (currentCompressedSize === 0 && !hasDataDescriptor) {
            return new Uint8Array(0);
          }

          if (!(await this.ensureBytes(currentCompressedSize))) {
            return null;
          }

          const compressedData = this.consume(currentCompressedSize);

          if (hasDataDescriptor) {
            if (await this.ensureBytes(4)) {
              const maybeSignature = this.readUint32(0);
              if (maybeSignature === 0x08074b50) {
                await this.ensureBytes(16);
                this.consume(16);
              } else {
                await this.ensureBytes(12);
                this.consume(12);
              }
            }
          }

          if (compressionMethod === 0) {
            return compressedData;
          } else if (compressionMethod === 8) {
            try {
              return await inflateRaw(compressedData);
            } catch {
              return null;
            }
          }
          return null;
        },
      };
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // Ignore cancellation errors
    }
  }
}

async function inflateRaw(compressedData: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressedData);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// ==================== FILE FILTERING ====================

function shouldIncludeFile(context: {
  yamlParse?: any;
  filePath: string;
  includeExt?: string[];
  excludeExt?: string[];
  includeDir?: string[];
  excludeDir?: string[];
  paths?: string[];
  matchFilenames?: string[];
}): boolean {
  const {
    excludeDir,
    excludeExt,
    filePath,
    includeDir,
    includeExt,
    paths,
    yamlParse,
    matchFilenames,
  } = context;
  const ext = filePath.split(".").pop()!;
  const lowercaseFilename = filePath.split("/").pop()!.toLowerCase();

  if (
    matchFilenames &&
    !matchFilenames.find((name) => name.toLowerCase() === lowercaseFilename)
  ) {
    return false;
  }
  if (includeExt && !includeExt.includes(ext)) return false;
  if (excludeExt && excludeExt.includes(ext)) return false;

  const pathAllowed =
    paths && paths.length > 0
      ? paths.some((path) => filePath.startsWith(path))
      : true;

  if (yamlParse) {
    const isInYamlFilter: null | undefined = filePath
      .split("/")
      .reduce((yaml, chunk) => yaml?.[chunk], yamlParse);
    return isInYamlFilter === null && pathAllowed;
  } else if (!pathAllowed) {
    return false;
  }

  if (includeDir && !includeDir.some((d) => filePath.slice(1).startsWith(d)))
    return false;
  if (excludeDir && excludeDir.some((d) => filePath.slice(1).startsWith(d)))
    return false;

  return true;
}

function isValidUtf8(data: Uint8Array): boolean {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(data);
    return true;
  } catch {
    return false;
  }
}

async function calculateHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ==================== STREAMING ZIP PROCESSOR ====================

interface ProcessedFile {
  path: string;
  content: ContentType;
  tokens: number;
  lines: number;
}

interface StreamingParseContext {
  owner: string;
  repo: string;
  branch?: string;
  includeExt?: string[];
  excludeExt?: string[];
  yamlFilter?: string;
  paths?: string[];
  includeDir?: string[];
  excludeDir?: string[];
  disableGenignore?: boolean;
  maxFileSize?: number;
  matchFilenames?: string[];
  maxTokens: number;
  shouldAddLineNumbers: boolean;
}

function addLineNumbers(
  content: string,
  shouldAddLineNumbers: boolean,
): string {
  if (!shouldAddLineNumbers) return content;
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalCharacters = String(totalLines).length;
  return lines
    .map((line, index) => {
      const lineNum = index + 1;
      const spacesNeeded = totalCharacters - String(lineNum).length;
      return " ".repeat(spacesNeeded) + String(lineNum) + " | " + line;
    })
    .join("\n");
}

function calculateFileTokens(
  path: string,
  content: string,
  shouldAddLineNumbers: boolean,
): number {
  const processed = addLineNumbers(content, shouldAddLineNumbers);
  const fileString = `${path}:\n${"-".repeat(
    80,
  )}\n${processed}\n\n\n${"-".repeat(80)}\n`;
  return Math.ceil(fileString.length / CHARACTERS_PER_TOKEN);
}

function calculateFileLines(content: string): number {
  return content.split("\n").length;
}

async function parseZipStreaming(
  stream: ReadableStream<Uint8Array>,
  context: StreamingParseContext,
): Promise<{
  status: number;
  result?: { [path: string]: ContentType };
  allPaths?: string[];
  shaOrBranch?: string;
  message?: string;
  totalTokens: number;
  totalLines: number;
  usedTokens: number;
}> {
  const {
    owner,
    repo,
    branch,
    excludeExt,
    includeExt,
    paths,
    includeDir,
    excludeDir,
    disableGenignore,
    maxFileSize,
    yamlFilter,
    matchFilenames,
    maxTokens,
    shouldAddLineNumbers,
  } = context;

  let yamlParse: any;
  try {
    if (yamlFilter) {
      yamlParse = parseYaml(yamlFilter);
    }
  } catch (e: any) {
    return {
      status: 500,
      message:
        "Couldn't parse yaml filter. Please ensure to provide valid url-encoded YAML. " +
        e.message,
      totalTokens: 0,
      totalLines: 0,
      usedTokens: 0,
    };
  }

  const shaOrBranch = branch || "HEAD";
  const zipReader = new StreamingZipReader(stream);

  const allFiles: Map<string, { data: Uint8Array; isText: boolean }> =
    new Map();
  const allPaths: string[] = [];
  let genignoreContent: string | null = DEFAULT_GENIGNORE;

  try {
    for await (const entry of zipReader.entries()) {
      if (entry.fileName.endsWith("/")) continue;

      const filePath = entry.fileName.split("/").slice(1).join("/");
      if (!filePath) continue;

      allPaths.push(filePath);

      if (filePath === ".genignore" && !disableGenignore) {
        const data = await entry.getData();
        if (data && isValidUtf8(data)) {
          genignoreContent = new TextDecoder("utf-8").decode(data);
        }
        continue;
      }

      if (
        !shouldIncludeFile({
          matchFilenames,
          filePath,
          yamlParse,
          includeExt,
          excludeExt,
          includeDir,
          excludeDir,
          paths,
        })
      ) {
        await entry.getData();
        continue;
      }

      const data = await entry.getData();
      if (!data) continue;

      const isText = isValidUtf8(data);

      if (isText && maxFileSize && data.length > maxFileSize) {
        continue;
      }

      allFiles.set(filePath, { data, isText });
    }
  } catch (e) {
    // Stream might have ended early, continue with what we have
  }

  const genignore =
    genignoreContent && !disableGenignore
      ? compileGitignore(genignoreContent)
      : undefined;

  const processedFiles: ProcessedFile[] = [];
  let totalTokens = 0;
  let totalLines = 0;

  for (const [filePath, { data, isText }] of allFiles) {
    if (genignore && !genignore.accepts(filePath)) {
      continue;
    }

    const hash = await calculateHash(data);

    if (isText) {
      const content = new TextDecoder("utf-8").decode(data);
      const tokens = calculateFileTokens(
        "/" + filePath,
        content,
        shouldAddLineNumbers,
      );
      const lines = calculateFileLines(content);

      processedFiles.push({
        path: "/" + filePath,
        content: {
          type: "content",
          content,
          hash,
          size: data.length,
          url: undefined,
        },
        tokens,
        lines,
      });

      totalTokens += tokens;
      totalLines += lines;
    } else {
      const tokens = Math.ceil(
        (
          `/${filePath}:\n` +
          "-".repeat(80) +
          `\nhttps://raw.githubusercontent.com/${owner}/${repo}/${shaOrBranch}/${filePath}\n\n\n` +
          "-".repeat(80) +
          "\n"
        ).length / CHARACTERS_PER_TOKEN,
      );

      processedFiles.push({
        path: "/" + filePath,
        content: {
          type: "binary",
          content: undefined,
          hash,
          size: data.length,
          url: `https://raw.githubusercontent.com/${owner}/${repo}/${shaOrBranch}/${filePath}`,
        },
        tokens,
        lines: 1,
      });

      totalTokens += tokens;
      totalLines += 1;
    }
  }

  processedFiles.sort((a, b) => a.tokens - b.tokens);

  const result: { [path: string]: ContentType } = {};
  let usedTokens = 0;

  for (const file of processedFiles) {
    if (usedTokens + file.tokens <= maxTokens) {
      result[file.path] = file.content;
      usedTokens += file.tokens;
    }
  }

  return {
    status: 200,
    result,
    allPaths,
    shaOrBranch,
    totalTokens,
    totalLines,
    usedTokens,
  };
}

// ==================== WWW-AUTHENTICATE HELPER ====================

function createWWWAuthenticateHeader(url: URL, scope: string = "read"): string {
  return (
    `Bearer realm="${url.hostname}", ` +
    `resource_metadata="${url.origin}/.well-known/oauth-protected-resource", ` +
    `scope="${scope}"`
  );
}

function createUnauthorizedResponse(
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

// ==================== MODAL HTML GENERATION ====================

type ModalState =
  | "login_required"
  | "private_access_required"
  | "credit_required"
  | null;

function generateModalHTML(
  state: ModalState,
  context: {
    loginUrl: string;
    privateAccessUrl: string;
    paymentLink: string | null;
    credit: number;
    username?: string;
    profilePicture?: string;
  },
): string {
  if (!state) return "";

  const {
    loginUrl,
    privateAccessUrl,
    paymentLink,
    credit,
    username,
    profilePicture,
  } = context;

  const modalStyles = `
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    }
    .modal-content {
      background: linear-gradient(145deg, #1e1e2e 0%, #2a2a3e 100%);
      border-radius: 16px;
      padding: 40px;
      max-width: 450px;
      width: 90%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .modal-icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
    .modal-title {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 12px;
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .modal-description {
      color: rgba(255, 255, 255, 0.7);
      margin-bottom: 24px;
      line-height: 1.6;
    }
    .modal-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 28px;
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      color: white;
      text-decoration: none;
      border-radius: 12px;
      font-weight: 600;
      font-size: 16px;
      transition: all 0.3s ease;
      border: none;
      cursor: pointer;
      width: 100%;
      box-sizing: border-box;
    }
    .modal-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(139, 92, 246, 0.4);
    }
    .modal-button-secondary {
      background: rgba(255, 255, 255, 0.1);
      margin-top: 12px;
    }
    .modal-button-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
      box-shadow: none;
    }
    .modal-steps {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
    }
    .modal-step {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      text-align: left;
    }
    .modal-step-number {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 14px;
      flex-shrink: 0;
    }
    .modal-step-completed {
      background: #22c55e;
    }
    .modal-step-text {
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
    }
    .modal-credit {
      background: rgba(255, 255, 255, 0.05);
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .modal-credit-label {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .modal-credit-value {
      font-size: 32px;
      font-weight: 700;
      color: ${credit >= PRIVATE_REPO_COST_CENTS ? "#22c55e" : "#ef4444"};
    }
    .modal-user {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .modal-user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
    }
    .modal-user-name {
      font-weight: 600;
      color: rgba(255, 255, 255, 0.9);
    }
  `;

  let modalContent = "";

  if (state === "login_required") {
    modalContent = `
      <div class="modal-icon">🔐</div>
      <h2 class="modal-title">Sign in to Continue</h2>
      <p class="modal-description">
        Sign in with GitHub to access uithub and view repository contents optimized for LLMs.
      </p>
      <a href="${loginUrl}" class="modal-button">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        Sign in with GitHub
      </a>
    `;
  } else if (state === "private_access_required") {
    modalContent = `
      <div class="modal-icon">🔒</div>
      <h2 class="modal-title">Private Repository Access</h2>
      ${
        username && profilePicture
          ? `
        <div class="modal-user">
          <img src="${profilePicture}" alt="${username}" class="modal-user-avatar">
          <span class="modal-user-name">@${username}</span>
        </div>
      `
          : ""
      }
      <p class="modal-description">
        This is a private repository. You need to grant additional GitHub permissions to access it.
      </p>
      <div class="modal-steps">
        <div class="modal-step">
          <div class="modal-step-number modal-step-completed">✓</div>
          <span class="modal-step-text">Signed in to uithub</span>
        </div>
        <div class="modal-step">
          <div class="modal-step-number">2</div>
          <span class="modal-step-text">Grant private repository access</span>
        </div>
      </div>
      <a href="${privateAccessUrl}" class="modal-button">
        Grant Private Repo Access
      </a>
    `;
  } else if (state === "credit_required") {
    modalContent = `
      <div class="modal-icon">💳</div>
      <h2 class="modal-title">Add Credit to Continue</h2>
      ${
        username && profilePicture
          ? `
        <div class="modal-user">
          <img src="${profilePicture}" alt="${username}" class="modal-user-avatar">
          <span class="modal-user-name">@${username}</span>
        </div>
      `
          : ""
      }
      <div class="modal-credit">
        <div class="modal-credit-label">Current Balance</div>
        <div class="modal-credit-value">$${(credit / 100).toFixed(2)}</div>
      </div>
      <p class="modal-description">
        Private repository access costs $0.01 per request. Add credit to your account to continue.
      </p>
      <div class="modal-steps">
        <div class="modal-step">
          <div class="modal-step-number modal-step-completed">✓</div>
          <span class="modal-step-text">Signed in to uithub</span>
        </div>
        <div class="modal-step">
          <div class="modal-step-number modal-step-completed">✓</div>
          <span class="modal-step-text">Private repository access granted</span>
        </div>
        <div class="modal-step">
          <div class="modal-step-number">3</div>
          <span class="modal-step-text">Add credit</span>
        </div>
      </div>
      <a href="${paymentLink}" class="modal-button" target="_blank">
        Add Credit via Stripe
      </a>
      <button onclick="window.location.reload()" class="modal-button modal-button-secondary">
        I've Added Credit - Refresh
      </button>
    `;
  }

  return `
    <style>${modalStyles}</style>
    <div class="modal-overlay">
      <div class="modal-content">
        ${modalContent}
      </div>
    </div>
  `;
}

// ==================== HTML GENERATION ====================

function generateViewHTML(context: {
  url: URL;
  fileString: string;
  tree: any;
  tokens: number;
  totalTokens: number;
  totalLines: number;
  title: string;
  description: string;
  default_branch?: string;
  modalState: ModalState;
  modalContext: {
    loginUrl: string;
    privateAccessUrl: string;
    paymentLink: string | null;
    credit: number;
    username?: string;
    profilePicture?: string;
  };
}): string {
  const {
    description,
    fileString,
    title,
    tokens,
    totalTokens,
    totalLines,
    tree,
    url,
    default_branch,
    modalState,
    modalContext,
  } = context;
  const [_, owner, repo, page, branch, ...pathParts] = url.pathname.split("/");

  const currentPageUrl = encodeURIComponent(
    url.origin + url.pathname + url.search,
  );
  const chatgptUrl = `https://chatgpt.com/?hints=search&prompt=Read+from+${currentPageUrl}+so+I+can+ask+questions+about+it.`;
  const claudeUrl = `https://claude.ai/new?q=Read%20from%20${currentPageUrl}%20so%20I%20can%20ask%20questions%20about%20it.`;

  const contentBlurStyle = modalState
    ? "pointer-events: none; user-select: none;"
    : "";

  const isLoggedIn = !!modalContext.username;
  const logoutUrl = `/logout?redirect_to=${encodeURIComponent(
    url.pathname + url.search,
  )}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <style>
    :root {
      --bg-color: white;
      --text-color: black;
      --header-bg: white;
      --header-border: black;
      --button-bg: #f0f0f0;
      --button-border: #ccc;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg-color: #1a1a1a;
        --text-color: #f0f0f0;
        --header-bg: #2a2a2a;
        --header-border: #444;
        --button-bg: #3a3a3a;
        --button-border: #555;
      }
      a { color: white; }
    }
    body { 
      margin: 0; 
      font-family: Arial, sans-serif; 
      padding-top: 100px; 
      background-color: var(--bg-color); 
      color: var(--text-color); 
    }
    header {
      background-color: var(--header-bg);
      border-bottom: 1px solid var(--header-border);
      padding: 10px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      ${contentBlurStyle}
    }
    button, select, input {
      background-color: var(--button-bg);
      border: 1px solid var(--button-border);
      color: var(--text-color);
      padding: 5px 10px;
      cursor: pointer;
      margin: 2px;
    }
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      margin: 0;
      padding: 10px;
    }
    #filterContainer {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .copy-menu-container { position: relative; }
    .copy-button {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 8px 16px;
      color: var(--text-color);
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: all 0.2s;
      justify-content: space-between;
      min-width: 140px;
    }
    .copy-button:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .button-left { display: flex; align-items: center; gap: 8px; flex: 1; }
    .icon { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; }
    .arrow-icon { width: 14px; height: 14px; transition: transform 0.3s; }
    .arrow-icon.rotated { transform: rotate(180deg); }
    .menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: rgba(20, 20, 20, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      overflow: hidden;
      opacity: 0;
      visibility: hidden;
      transform: translateY(-10px);
      transition: all 0.3s;
      backdrop-filter: blur(20px);
      min-width: 350px;
      z-index: 1001;
    }
    .menu.open { opacity: 1; visibility: visible; transform: translateY(0); }
    .menu-item {
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
      cursor: pointer;
      text-decoration: none;
      color: var(--text-color);
      transition: background 0.2s;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .menu-item:last-child { border-bottom: none; }
    .menu-item:hover { background: rgba(255, 255, 255, 0.05); }
    .menu-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .menu-icon img { width: 24px; height: 24px; border-radius: 4px; }
    .menu-content { flex: 1; }
    .menu-title { font-size: 16px; font-weight: 500; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    .menu-description { font-size: 14px; color: rgba(255, 255, 255, 0.6); }
    .external-icon { width: 14px; height: 14px; opacity: 0.6; }
    textarea { position: absolute; left: -9999px; }
    .content-container {
      ${contentBlurStyle}
    }
    .user-section {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 2px solid rgba(139, 92, 246, 0.5);
    }
    .user-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .user-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-color);
    }
    .user-credit {
      font-size: 11px;
      color: #22c55e;
      font-weight: 500;
     }
    .logout-btn {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .logout-btn:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: rgba(239, 68, 68, 0.5);
    }
    .login-btn {
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .login-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
    }
    .header-right {
      display: flex;
      flex-direction: row;
      gap: 12px;
      align-items: center;
      justify-content: center;
    }
  </style>
</head>
<body>
  ${generateModalHTML(modalState, modalContext)}
  <header>
    <div id="filterContainer">
      <select id="formatSelect" onchange="updateFilters()">
        <option value="">Format: HTML</option>
        <option value="application/json">Format: JSON</option>
        <option value="text/yaml">Format: YAML</option>
        <option value="text/plain">Format: Text</option>
      </select>
      <span style="font-size:12px">max tokens</span>
      <input type="search" id="maxTokensInput" onchange="updateFilters()">
      <select id="extSelect" onchange="updateFilters()"></select>
      <select style="max-width: 200px;" id="locationSelect" onchange="navigateToLocation()"></select>
    </div>
    <div class="header-right">
      ${
        isLoggedIn
          ? `
        <div class="user-section">
          <img src="${modalContext.profilePicture}" alt="${
              modalContext.username
            }" class="user-avatar">
          <a href="${
            modalContext.paymentLink || "#"
          }" target="_blank" style="text-decoration:none;">
          <div class="user-info">
            <span class="user-name">@${modalContext.username}</span>
            ${
              modalContext.credit > 0
                ? `<span class="user-credit">$${(
                    modalContext.credit / 100
                  ).toFixed(2)} credit</span>`
                : ""
            }
          </div>
          </a>
          <a href="${logoutUrl}" class="logout-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Logout
          </a>
        </div>
      `
          : `
        <a href="${modalContext.loginUrl}" class="login-btn">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          Sign in
        </a>
      `
      }
      <p id="tokens">~${tokens} tokens</p>
      
      <div class="copy-menu-container">
        <button class="copy-button" id="mainButton">
          <div class="button-left" id="copyPart">
            <svg class="icon" viewBox="0 0 24 24">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span id="buttonText">Copy page</span>
          </div>
          <svg class="arrow-icon" id="arrowIcon" viewBox="0 0 24 24">
            <polyline points="6 9 12 15 18 9" stroke="currentColor" fill="none" stroke-width="2"></polyline>
          </svg>
        </button>

        <div class="menu" id="menu">
          <div class="menu-item" id="copyMarkdown">
            <div class="menu-icon">
              <svg class="icon" viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </div>
            <div class="menu-content">
              <div class="menu-title">Copy page</div>
              <div class="menu-description">Copy page as Markdown for LLMs</div>
            </div>
          </div>

          <a class="menu-item" href="${chatgptUrl}" target="_blank">
            <div class="menu-icon">
              <img src="https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64" alt="ChatGPT">
            </div>
            <div class="menu-content">
              <div class="menu-title">
                Open in ChatGPT
                <svg class="external-icon" viewBox="0 0 24 24">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" fill="none" stroke-width="2"></path>
                  <polyline points="15 3 21 3 21 9" stroke="currentColor" fill="none" stroke-width="2"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"></line>
                </svg>
              </div>
              <div class="menu-description">Ask questions about this page</div>
            </div>
          </a>

          <a class="menu-item" href="${claudeUrl}" target="_blank">
            <div class="menu-icon">
              <img src="https://www.google.com/s2/favicons?domain=claude.ai&sz=64" alt="Claude">
            </div>
            <div class="menu-content">
              <div class="menu-title">
                Open in Claude
                <svg class="external-icon" viewBox="0 0 24 24">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" fill="none" stroke-width="2"></path>
                  <polyline points="15 3 21 3 21 9" stroke="currentColor" fill="none" stroke-width="2"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"></line>
                </svg>
              </div>
              <div class="menu-description">Ask questions about this page</div>
            </div>
          </a>

          <a class="menu-item" href="https://cursor.com/en/install-mcp?name=uithub&config=eyJ1cmwiOiJodHRwczovL21jcC51aXRodWIuY29tL21jcCJ9" target="_blank">
            <div class="menu-icon">
              <img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor">
            </div>
            <div class="menu-content">
              <div class="menu-title">
                Connect to Cursor
                <svg class="external-icon" viewBox="0 0 24 24">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" fill="none" stroke-width="2"></path>
                  <polyline points="15 3 21 3 21 9" stroke="currentColor" fill="none" stroke-width="2"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"></line>
                </svg>
              </div>
              <div class="menu-description">Install MCP Server on Cursor</div>
            </div>
          </a>

          <a class="menu-item" href="https://insiders.vscode.dev/redirect/mcp/install?name=uithub&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.uithub.com%2Fmcp%22%7D" target="_blank">
            <div class="menu-icon">
              <img src="https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=64" alt="VS Code">
            </div>
            <div class="menu-content">
              <div class="menu-title">
                Connect to VS Code
                <svg class="external-icon" viewBox="0 0 24 24">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" fill="none" stroke-width="2"></path>
                  <polyline points="15 3 21 3 21 9" stroke="currentColor" fill="none" stroke-width="2"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"></line>
                </svg>
              </div>
              <div class="menu-description">Install MCP Server on VS Code</div>
            </div>
          </a>
        </div>
      </div>
      
      <a href="${url.origin.replace("uithub.com", "github.com")}${
    url.pathname
  }" target="_blank">
        <svg class="github-icon" viewBox="0 0 16 16" version="1.1" width="32" height="32">
          <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </a>
    </div>
  </header>
  <div class="content-container" style="max-width: 100vw; margin-top:35px;">
    <pre id="textToCopy">${escapeHTML(fileString)}</pre>
  </div>
  
  <textarea id="copyContent">${escapeHTML(fileString)}</textarea>
  
  <script>
    const data = ${JSON.stringify({
      default_branch,
      tokens: totalTokens,
      totalLines,
    })};
    const tree = ${JSON.stringify(tree)};
    
    const mainButton = document.getElementById('mainButton');
    const copyPart = document.getElementById('copyPart');
    const arrowIcon = document.getElementById('arrowIcon');
    const buttonText = document.getElementById('buttonText');
    const menu = document.getElementById('menu');
    const copyContent = document.getElementById('copyContent');
    const copyMarkdown = document.getElementById('copyMarkdown');
    
    let menuOpen = false;
    
    mainButton.addEventListener('click', (e) => {
      const rect = arrowIcon.getBoundingClientRect();
      const clickX = e.clientX;
      if (clickX > rect.left - 30) {
        toggleMenu();
      } else {
        copyToClipboard();
      }
    });
    
    copyPart.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard();
    });
    
    function toggleMenu() {
      menuOpen = !menuOpen;
      menu.classList.toggle('open', menuOpen);
      arrowIcon.classList.toggle('rotated', menuOpen);
    }
    
    function copyToClipboard() {
      copyContent.select();
      document.execCommand('copy');
      const originalText = buttonText.textContent;
      buttonText.textContent = 'Copied';
      setTimeout(() => { buttonText.textContent = originalText; }, 1000);
    }
    
    copyMarkdown.addEventListener('click', () => {
      copyToClipboard();
      toggleMenu();
    });
    
    document.addEventListener('click', (e) => {
      if (!mainButton.contains(e.target) && !menu.contains(e.target)) {
        menuOpen = false;
        menu.classList.remove('open');
        arrowIcon.classList.remove('rotated');
      }
    });
    
    function updateFilters() {
      const format = document.getElementById('formatSelect').value;
      const maxTokens = document.getElementById('maxTokensInput').value;
      const ext = document.getElementById('extSelect').value;
      let url = new URL(window.location.href);
      
      if (format) {
        url.searchParams.set('accept', format);
      } else {
        url.searchParams.delete('accept');
      }
      
      if (maxTokens) {
        url.searchParams.set('maxTokens', maxTokens);
      } else {
        url.searchParams.delete('maxTokens');
      }
      
      if (ext) {
        url.searchParams.set('ext', ext);
      } else {
        url.searchParams.delete('ext');
      }
      
      window.location.href = url.toString();
    }
    
    function navigateToLocation() {
      const location = document.getElementById('locationSelect').value;
      let url = new URL(window.location.href);
      const [_, owner, repo, page, branch, ...pathParts] = url.pathname.split("/");
      const locationPart = location === "" ? "" : "/" + location;
      window.location.href = url.origin + "/" + owner + "/" + repo + "/tree/" + (branch || data.default_branch || "main") + locationPart + url.search;
    }
    
    function populateExtensions(tree) {
      const extensions = new Set();
      function traverse(node, level = 0) {
        if (typeof node === 'object' && node !== null) {
          for (let key in node) {
            if (node[key] === null) {
              const ext = key.split('.').pop();
              if (ext !== key) extensions.add(ext);
            } else if (level < 4) {
              traverse(node[key], level + 1);
            }
          }
        }
      }
      traverse(tree);
      const extSelect = document.getElementById('extSelect');
      extSelect.innerHTML = '<option value="">All Extensions</option>';
      extensions.forEach(ext => {
        const option = document.createElement('option');
        option.value = ext;
        option.textContent = ext;
        extSelect.appendChild(option);
      });
    }
    
    function populateLocations(tree) {
      const locationSelect = document.getElementById('locationSelect');
      locationSelect.innerHTML = '<option value="">Base path: root</option>';
      function traverse(node, path = '', level = 0) {
        for (let key in node) {
          const newPath = path ? path + "/" + key : key;
          const option = document.createElement('option');
          option.value = newPath;
          option.textContent = newPath;
          if (typeof node[key] === 'object' && node[key] !== null) {
            locationSelect.appendChild(option);
            if (level < 3) {
              traverse(node[key], newPath, level + 1);
            }
          }
        }
      }
      traverse(tree);
    }
    
    function initializeFromURL() {
      const url = new URL(window.location.href);
      const format = url.searchParams.get('accept') || "";
      document.getElementById('formatSelect').value = format;
      document.getElementById('maxTokensInput').value = url.searchParams.get('maxTokens') || '50000';
      document.getElementById('extSelect').value = url.searchParams.get('ext') || '';
      const [_, owner, repo, page, branch, ...pathParts] = url.pathname.split("/");
      const path = pathParts.join("/");
      document.getElementById('locationSelect').value = path;
    }
    
    window.onload = function () {
      populateExtensions(tree);
      populateLocations(tree);
      initializeFromURL();
    };
  </script>
  <!-- 100% privacy-first analytics -->
<script async src="https://scripts.simpleanalyticscdn.com/latest.js"></script>

</body>
</html>`;
}

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

// ==================== CHECK REPO ACCESS ====================

async function checkRepoAccess(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<{ exists: boolean; isPrivate: boolean; default_branch?: string }> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uithub",
  };
  if (token) headers["Authorization"] = `token ${token}`;
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers },
  );
  if (response.status === 404) {
    return { exists: false, isPrivate: true };
  }
  if (!response.ok) {
    return { exists: false, isPrivate: false };
  }
  const data = (await response.json()) as any;
  return {
    exists: true,
    isPrivate: data.private || false,
    default_branch: data.default_branch,
  };
}

// ==================== DETERMINE RESPONSE FORMAT ====================

interface ResponseFormat {
  type: "html" | "json" | "yaml" | "markdown";
  requiresAuth: boolean;
}

function determineResponseFormat(request: Request, url: URL): ResponseFormat {
  const acceptParam = url.searchParams.get("accept");
  const acceptHeader = request.headers.get("Accept") || "";

  // Check query param first
  if (acceptParam) {
    if (acceptParam === "application/json") {
      return { type: "json", requiresAuth: true };
    }
    if (acceptParam === "text/yaml") {
      return { type: "yaml", requiresAuth: true };
    }
    if (acceptParam === "text/plain" || acceptParam === "text/markdown") {
      return { type: "markdown", requiresAuth: true };
    }
  }

  // Check Accept header
  if (acceptHeader === "*/*" || acceptHeader === "") {
    // Default to markdown for programmatic access (like curl without Accept header)
    return { type: "markdown", requiresAuth: true };
  }

  if (acceptHeader.includes("text/html")) {
    return { type: "html", requiresAuth: true };
  }

  if (acceptHeader.includes("application/json")) {
    return { type: "json", requiresAuth: true };
  }

  if (acceptHeader.includes("text/yaml")) {
    return { type: "yaml", requiresAuth: true };
  }

  if (
    acceptHeader.includes("text/plain") ||
    acceptHeader.includes("text/markdown")
  ) {
    return { type: "markdown", requiresAuth: true };
  }

  // Default to markdown for any other case
  return { type: "markdown", requiresAuth: true };
}

// ==================== MAIN HANDLER ====================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle OAuth well-known endpoints
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return handleOAuthProtectedResource(url);
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return handleOAuthAuthorizationServer(url);
    }

    // Handle OAuth endpoints
    if (url.pathname === "/register" && request.method === "POST") {
      return handleClientRegistration(request, env);
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/token" && request.method === "POST") {
      return handleToken(request, env);
    }

    // Handle browser login flow
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

    // Handle Stripe webhook
    if (url.pathname === "/webhook/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    const [_, owner, repo, page, branch, ...pathParts] =
      url.pathname.split("/");

    // folders need an additional slash
    const path = pathParts.join("/");

    // Get authentication - check Bearer token first, then session cookie
    const bearerToken = getBearerToken(request);
    const session = getSessionFromCookie(request);

    let githubAccessToken: string | null = null;
    let currentUser: any = null;
    let sessionScopes: string = "";

    if (bearerToken) {
      // Validate bearer token from OAuth flow
      const tokenData = await getAccessTokenData(bearerToken, env);
      if (tokenData && Date.now() < tokenData.expires_at) {
        githubAccessToken = tokenData.github_access_token;
        // Fetch user info to get currentUser
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
    } else if (session.accessToken) {
      // Use session cookie
      githubAccessToken = session.accessToken;
      currentUser = session.user;
      sessionScopes = session.scopes;
    }

    // Determine response format
    const responseFormat = determineResponseFormat(request, url);

    // Root - show index.html (no auth required for root)
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
      // Check authentication for profile pages
      if (!currentUser && responseFormat.requiresAuth) {
        if (responseFormat.type === "html") {
          // Redirect to login for HTML
          const loginUrl = `${
            url.origin
          }/login?scope=user:email&resource=${encodeURIComponent(
            url.origin,
          )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;
          return Response.redirect(loginUrl, 302);
        } else {
          return createUnauthorizedResponse(url, "read");
        }
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
          { headers },
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

        if (responseFormat.type === "markdown") {
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

    // Repository content - authentication required for all formats
    if (!currentUser && responseFormat.requiresAuth) {
      if (responseFormat.type === "html") {
        // For HTML, show login modal
        const loginUrl = `${
          url.origin
        }/login?scope=user:email&resource=${encodeURIComponent(
          url.origin,
        )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;
        const privateAccessUrl = `${
          url.origin
        }/login?scope=repo&resource=${encodeURIComponent(
          url.origin,
        )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;

        const modalContext = {
          loginUrl,
          privateAccessUrl,
          paymentLink: null,
          credit: 0,
          username: undefined,
          profilePicture: undefined,
        };

        const placeholderFileString =
          "Content hidden. Please sign in to continue.";
        const placeholderTree = {};

        const branchPart = branch ? ` at ${branch}` : "";
        const title = `${owner}/${repo} - uithub`;
        const description = `LLM context for ${repo}. /${path}${branchPart}`;

        const viewHtml = generateViewHTML({
          url,
          title,
          description,
          fileString: placeholderFileString,
          tokens: 0,
          totalTokens: 0,
          totalLines: 0,
          tree: placeholderTree,
          default_branch: undefined,
          modalState: "login_required",
          modalContext,
        });

        return new Response(viewHtml, {
          headers: {
            "Content-Type": "text/html",
            "X-XSS-Protection": "1; mode=block",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      } else {
        // For non-HTML, return 401 with WWW-Authenticate header
        return createUnauthorizedResponse(url, "read");
      }
    }

    // User is authenticated, check repo access
    try {
      const repoAccess = await checkRepoAccess(owner, repo, githubAccessToken);

      // Prepare modal context
      const loginUrl = `${
        url.origin
      }/login?scope=user:email&resource=${encodeURIComponent(
        url.origin,
      )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;
      const privateAccessUrl = `${
        url.origin
      }/login?scope=repo&resource=${encodeURIComponent(
        url.origin,
      )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;

      let userAccount: UserAccount | null = null;
      if (currentUser) {
        userAccount = await getUserAccount(String(currentUser.id), env);
      }

      const paymentLink = currentUser
        ? `${env.STRIPE_PAYMENT_LINK}?client_reference_id=${currentUser.id}`
        : null;

      const modalContext = {
        loginUrl,
        privateAccessUrl,
        paymentLink,
        credit: userAccount?.credit || 0,
        username: currentUser?.login,
        profilePicture: currentUser?.avatar_url,
      };

      // Determine modal state for private repos
      let modalState: ModalState = null;

      if (!repoAccess.exists || repoAccess.isPrivate) {
        if (!sessionScopes.includes("repo")) {
          // Need private repo scope
          if (responseFormat.type === "html") {
            modalState = "private_access_required";
          } else {
            return new Response(
              "Private repository access required. Please authenticate with 'repo' scope.",
              {
                status: 403,
                headers: {
                  "WWW-Authenticate": createWWWAuthenticateHeader(url, "repo"),
                },
              },
            );
          }
        } else if (
          !userAccount ||
          userAccount.credit < PRIVATE_REPO_COST_CENTS
        ) {
          // Need credit
          if (responseFormat.type === "html") {
            modalState = "credit_required";
          } else {
            return new Response(
              `Insufficient credit. Balance: $${(
                (userAccount?.credit || 0) / 100
              ).toFixed(2)}. Required: $0.01`,
              { status: 402 },
            );
          }
        } else {
          // All good - charge for private repo access
          const chargeResult = await chargeForPrivateRepo(
            String(currentUser.id),
            env,
          );
          if (!chargeResult.success) {
            if (responseFormat.type === "html") {
              modalState = "credit_required";
            } else {
              return new Response(chargeResult.message, { status: 402 });
            }
          }
        }
      }

      // If modal state is set for HTML, show modal with blurred content
      if (modalState && responseFormat.type === "html") {
        const placeholderFileString =
          "Content hidden. Please complete the required steps first.";
        const placeholderTree = {};

        const branchPart = branch ? ` at ${branch}` : "";
        const title = `${owner}/${repo} - uithub`;
        const description = `LLM context for ${repo}. /${path}${branchPart}`;

        const viewHtml = generateViewHTML({
          url,
          title,
          description,
          fileString: placeholderFileString,
          tokens: 0,
          totalTokens: 0,
          totalLines: 0,
          tree: placeholderTree,
          default_branch: repoAccess.default_branch,
          modalState,
          modalContext,
        });

        return new Response(viewHtml, {
          headers: {
            "Content-Type": "text/html",
            "X-XSS-Protection": "1; mode=block",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      }

      // Parse query params
      const maxTokensParam = url.searchParams.get("maxTokens");
      const shouldAddLineNumbers = url.searchParams.get("lines") !== "false";
      const includeExt = url.searchParams.get("ext")?.split(",");
      const includeDir = url.searchParams.get("dir")?.split(",");
      const excludeExt = url.searchParams.get("exclude-ext")?.split(",");
      const excludeDir = url.searchParams.get("exclude-dir")?.split(",");
      const disableGenignore =
        url.searchParams.get("disableGenignore") === "true";
      const maxFileSize =
        parseInt(url.searchParams.get("maxFileSize") || "0", 10) || undefined;
      const yamlFilter = url.searchParams.get("yamlFilter") || undefined;
      const shouldOmitFiles = url.searchParams.get("omitFiles") === "true";
      const shouldOmitTree = url.searchParams.get("omitTree") === "true";
      const matchFilenames = url.searchParams
        .get("matchFilenames")
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      const maxTokens =
        maxTokensParam && !isNaN(Number(maxTokensParam))
          ? Number(maxTokensParam)
          : DEFAULT_MAX_TOKENS;

      // Fetch from GitHub
      const ref = branch && branch !== "" ? branch : "HEAD";
      const isPrivate = !!githubAccessToken && repoAccess.isPrivate;
      const branchSuffix = branch && branch !== "" ? `/${branch}` : "";
      const apiUrl = isPrivate
        ? `https://api.github.com/repos/${owner}/${repo}/zipball${branchSuffix}`
        : `https://github.com/${owner}/${repo}/archive/${ref}.zip`;
      const headers: HeadersInit = isPrivate
        ? { Authorization: `token ${githubAccessToken}` }
        : {};
      headers["User-Agent"] = "uithub";

      const response = await fetch(apiUrl, { headers });
      if (!response.ok || !response.body) {
        return new Response(`Failed to fetch repository: ${response.status}`, {
          status: response.status,
        });
      }

      // Stream-parse ZIP with token limit
      const result = await parseZipStreaming(response.body, {
        owner,
        repo,
        branch,
        excludeDir,
        excludeExt,
        includeDir,
        includeExt,
        yamlFilter,
        matchFilenames,
        paths: path ? [path] : undefined,
        disableGenignore,
        maxFileSize,
        maxTokens,
        shouldAddLineNumbers,
      });

      if (!result.result) {
        return new Response(result.message || "Error processing repository", {
          status: result.status,
        });
      }

      // Build tree from all paths for navigation
      const tree = filePathToNestedObject({ ...result.result }, () => null);
      const treeString = nestedObjectToTreeString(tree);
      const treeTokens = Math.round(treeString.length / CHARACTERS_PER_TOKEN);

      const stringifyFileContent = (path: string) => {
        const item = result.result![path] as any;
        const contentOrUrl =
          item.type === "content"
            ? addLineNumbers(item.content, shouldAddLineNumbers)
            : item.type === "binary"
            ? item.url
            : "";
        return `${path}:\n${"-".repeat(80)}\n${contentOrUrl}\n\n\n${"-".repeat(
          80,
        )}\n`;
      };

      const filePart = Object.keys(result.result)
        .map(stringifyFileContent)
        .join("");
      const fileString =
        treeString + (shouldOmitFiles ? "" : "\n\n" + filePart);
      const tokens = Math.round(
        (treeString + "\n\n" + filePart).length / CHARACTERS_PER_TOKEN,
      );

      // Return based on format
      if (responseFormat.type === "html") {
        const branchPart = branch ? ` at ${branch}` : "";
        const title = `${owner}/${repo} - uithub`;
        const description = `LLM context for ${repo}. /${path}${branchPart} contains ${tokens} tokens.`;

        const viewHtml = generateViewHTML({
          url,
          title,
          description,
          fileString,
          tokens,
          totalTokens: result.totalTokens + treeTokens,
          totalLines: result.totalLines,
          tree,
          default_branch: result.shaOrBranch || repoAccess.default_branch,
          modalState: null,
          modalContext,
        });

        return new Response(viewHtml, {
          headers: {
            "Content-Type": "text/html",
            "X-XSS-Protection": "1; mode=block",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      }

      if (responseFormat.type === "markdown") {
        return new Response(fileString, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }

      // JSON/YAML response
      const body = {
        size: {
          tokens,
          totalTokens: result.totalTokens + treeTokens,
          characters: (result.totalTokens + treeTokens) * CHARACTERS_PER_TOKEN,
          lines: result.totalLines,
        },
        tree: shouldOmitTree ? undefined : tree,
        files: shouldOmitFiles ? undefined : result.result,
      };

      if (responseFormat.type === "yaml") {
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "text/yaml" },
        });
      }

      return new Response(JSON.stringify(body, undefined, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};
