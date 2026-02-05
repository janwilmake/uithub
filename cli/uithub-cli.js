#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const crypto = require("crypto");

// Configuration
const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".uithub",
);
const TOKEN_FILE = path.join(CONFIG_DIR, "token.json");
const BASE_URL = "https://uithub.com";

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// PKCE helper functions
function base64URLEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64URLEncode(crypto.createHash("sha256").update(verifier).digest());
}

function generateRandomState() {
  return base64URLEncode(crypto.randomBytes(16));
}

// Token management
function saveToken(tokenData) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    // Check if token is expired
    if (data.expires_at && Date.now() >= data.expires_at) {
      console.log("Token expired, re-authenticating...");
      return null;
    }
    return data;
  } catch (err) {
    return null;
  }
}

// OAuth flow
async function registerClient() {
  console.log("Registering OAuth client...");

  const response = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:8765/callback"],
      client_name: "uithub-cli",
    }),
  });

  if (!response.ok) {
    throw new Error(`Registration failed: ${await response.text()}`);
  }

  return await response.json();
}

async function startAuthFlow() {
  console.log("Starting OAuth authentication flow...\n");

  // Register client
  const clientData = await registerClient();
  const { client_id, client_secret } = clientData;

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateRandomState();

  // Build authorization URL
  const authParams = new URLSearchParams({
    client_id,
    redirect_uri: "http://localhost:8765/callback",
    response_type: "code",
    scope: "read repo",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${BASE_URL}/authorize?${authParams}`;

  console.log("Opening browser for authentication...");
  console.log("If the browser does not open, visit this URL:");
  console.log(authUrl);
  console.log();

  // Try to open browser
  try {
    const openCommand =
      process.platform === "win32"
        ? "start"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    execSync(`${openCommand} "${authUrl}"`, { stdio: "ignore" });
  } catch (err) {
    // Browser open failed, user will use the printed URL
  }

  // Start local server to receive callback
  const code = await waitForCallback(state);

  // Exchange code for token
  console.log("\nExchanging authorization code for access token...");

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost:8765/callback",
    client_id,
    client_secret,
    code_verifier: codeVerifier,
  });

  const tokenResponse = await fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
  }

  const tokenData = await tokenResponse.json();

  // Add expiration timestamp
  tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;

  saveToken(tokenData);
  console.log("✓ Authentication successful!\n");

  return tokenData.access_token;
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const url = require("url");

    let timeoutId;

    const server = http.createServer((req, res) => {
      const query = url.parse(req.url, true).query;

      if (req.url.startsWith("/callback")) {
        if (query.error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authentication Failed</h1><p>${query.error_description || query.error}</p></body></html>`,
          );
          clearTimeout(timeoutId);
          server.close();
          reject(new Error(query.error_description || query.error));
          return;
        }

        if (query.state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>Invalid state parameter</p></body></html>",
          );
          clearTimeout(timeoutId);
          server.close();
          reject(new Error("Invalid state parameter"));
          return;
        }

        if (query.code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>",
          );
          clearTimeout(timeoutId);
          server.close();
          resolve(query.code);
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>No authorization code received</p></body></html>",
          );
          clearTimeout(timeoutId);
          server.close();
          reject(new Error("No authorization code received"));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(8765, () => {
      console.log(
        "Waiting for authentication callback on http://localhost:8765/callback",
      );
    });

    // Timeout after 5 minutes
    timeoutId = setTimeout(
      () => {
        server.close();
        reject(new Error("Authentication timeout"));
      },
      5 * 60 * 1000,
    );
  });
}

// API request
async function makeRequest(urlPath) {
  let token = loadToken();

  if (!token) {
    const accessToken = await startAuthFlow();
    token = { access_token: accessToken };
  }

  const fullUrl = urlPath.startsWith("http")
    ? urlPath
    : `${BASE_URL}${urlPath}`;

  console.log(`Fetching: ${fullUrl}\n`);

  const response = await fetch(fullUrl, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      console.log("Token invalid, re-authenticating...\n");
      fs.unlinkSync(TOKEN_FILE);
      return makeRequest(urlPath);
    }
    throw new Error(
      `Request failed: ${response.status} ${await response.text()}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await response.json();
  } else {
    return await response.text();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
uithub CLI - GitHub repository content fetcher with OAuth

Usage:
  uithub <url>                Fetch content from uithub
  uithub logout               Remove stored authentication
  uithub --help               Show this help message

Examples:
  uithub owner/repo
  uithub owner/repo?ext=ts,js
  uithub owner/repo?maxTokens=10000
  uithub owner/repo/issues/1
  uithub https://uithub.com/owner/repo?accept=application/json

Supported query parameters:
  ext              - Comma-separated file extensions (e.g., ts,js,md)
  exclude-ext      - Exclude file extensions
  dir              - Include specific directories
  exclude-dir      - Exclude directories
  maxFileSize      - Maximum file size in bytes
  maxTokens        - Maximum LLM tokens in response
  accept           - Response format (application/json, text/yaml, text/markdown, text/html)
  include          - Glob patterns to include (e.g., **/*.ts,src/**)
  exclude          - Glob patterns to exclude
  search           - Search file contents
  searchMatchCase  - Case-sensitive search (true/false)
  searchRegularExp - Use regex for search (true/false)
  omitFiles        - Omit file contents (true/false)
  omitTree         - Omit directory tree (true/false)
  lines            - Show line numbers (set to 'false' to disable)
  disableGenignore - Disable .genignore filtering (true/false)

For more info: https://uithub.com
`);
    process.exit(0);
  }

  if (args[0] === "logout") {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
      console.log("✓ Logged out successfully");
    } else {
      console.log("Not logged in");
    }
    process.exit(0);
  }

  try {
    let urlPath = args[0];

    // If it's not a full URL, construct one
    if (!urlPath.startsWith("http")) {
      if (!urlPath.startsWith("/")) {
        urlPath = "/" + urlPath;
      }
    }

    const result = await makeRequest(urlPath);

    if (typeof result === "string") {
      console.log(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

// Run CLI
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
