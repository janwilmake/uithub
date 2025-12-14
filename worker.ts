import { parse as parseYaml } from "yaml";

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
  maybe: (input: string) => boolean;
}

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

interface OAuthState {
  redirectTo?: string;
  codeVerifier: string;
  scope: string;
}

// ==================== CONSTANTS ====================

const CHARACTERS_PER_TOKEN = 5;
const DEFAULT_MAX_TOKENS = 50000;
const DEFAULT_GENIGNORE = `package-lock.json
build
node_modules
`;

// ==================== OAUTH HELPERS ====================

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

function getAccessToken(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sessionToken = cookies.session;
  if (!sessionToken) return null;
  try {
    const sessionData = JSON.parse(atob(sessionToken));
    if (Date.now() > sessionData.exp) return null;
    return sessionData.accessToken;
  } catch {
    return null;
  }
}

function getCurrentUser(request: Request): any | null {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sessionToken = cookies.session;
  if (!sessionToken) return null;
  try {
    const sessionData = JSON.parse(atob(sessionToken));
    if (Date.now() > sessionData.exp) return null;
    return sessionData.user;
  } catch {
    return null;
  }
}

async function handleLogin(
  request: Request,
  env: Env,
  scope: string,
): Promise<Response> {
  const url = new URL(request.url);
  const isLocalhost = url.hostname === "localhost";
  const redirectTo = url.searchParams.get("redirect_to") || "/";
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state: OAuthState = { redirectTo, codeVerifier, scope };
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
      "User-Agent": "OAuth-Worker",
    },
  });
  if (!userResponse.ok) {
    return new Response("Failed to get user info", { status: 400 });
  }
  const userData = (await userResponse.json()) as any;
  const sessionData = {
    user: userData,
    accessToken: tokenData.access_token,
    exp: Date.now() + 7 * 24 * 3600 * 1000,
  };
  console.log({ tokenData, sessionData });
  const sessionToken = btoa(JSON.stringify(sessionData));
  const headers = new Headers({ Location: state.redirectTo || "/" });
  const isLocalhost = url.hostname === "localhost";

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

function preparePartialRegex(pattern: string): string {
  return pattern
    .split("/")
    .map((item, index) =>
      index
        ? `([\\/]?(${prepareRegexPattern(item)}\\b|$))`
        : `(${prepareRegexPattern(item)}\\b)`,
    )
    .join("");
}

function createRegExp(patterns: string[]): RegExp {
  return patterns.length > 0
    ? new RegExp(`^((${patterns.join(")|(")}))`)
    : new RegExp("$^");
}

function prepareRegexes(pattern: string): [string, string] {
  return [prepareRegexPattern(pattern), preparePartialRegex(pattern)];
}

function parseGitignore(content: string): {
  positives: [RegExp, RegExp];
  negatives: [RegExp, RegExp];
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
  const processedLists = lists.map((list) =>
    list
      .sort()
      .map(prepareRegexes)
      .reduce<[string[], string[]]>(
        (acc, [exact, partial]) => {
          acc[0].push(exact);
          acc[1].push(partial);
          return acc;
        },
        [[], []],
      ),
  );
  return {
    positives: processedLists[0].map(createRegExp) as [RegExp, RegExp],
    negatives: processedLists[1].map(createRegExp) as [RegExp, RegExp],
  };
}

function compileGitignore(content: string): CompiledGitignore {
  const { positives, negatives } = parseGitignore(content);
  const checkInput = (input: string): string =>
    input[0] === "/" ? input.slice(1) : input;
  return {
    accepts: (input: string): boolean => {
      input = checkInput(input);
      return negatives[0].test(input) || !positives[0].test(input);
    },
    denies: (input: string): boolean => {
      input = checkInput(input);
      return !(negatives[0].test(input) || !positives[0].test(input));
    },
    maybe: (input: string): boolean => {
      input = checkInput(input);
      return negatives[1].test(input) || !positives[1].test(input);
    },
  };
}

// ==================== DEFLATE DECOMPRESSION ====================

/**
 * Decompress DEFLATE-compressed data using the DecompressionStream API
 * This handles ZIP files that use compression method 8 (DEFLATE)
 */
async function inflateRaw(compressedData: Uint8Array): Promise<Uint8Array> {
  // DecompressionStream with 'deflate-raw' handles raw DEFLATE without zlib headers
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write compressed data and close
  writer.write(compressedData);
  writer.close();

  // Read all decompressed chunks
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // Combine chunks into single array
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// ==================== ZIP PARSING ====================

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

/**
 * Check if data is valid UTF-8 text
 */
function isValidUtf8(data: Uint8Array): boolean {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate SHA-256 hash of data
 */
async function calculateHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function parseZipStream(
  stream: ReadableStream,
  context: {
    owner: string;
    repo: string;
    branch?: string;
    includeExt?: string[];
    excludeExt?: string[];
    yamlFilter?: string;
    shouldOmitFiles: boolean;
    paths?: string[];
    includeDir?: string[];
    excludeDir?: string[];
    disableGenignore?: boolean;
    maxFileSize?: number;
    matchFilenames?: string[];
  },
): Promise<{
  status: number;
  result?: { [path: string]: ContentType };
  shaOrBranch?: string;
  message?: string;
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
    };
  }

  const fileContents: { [path: string]: ContentType } = {};
  let genignoreString: string | null = DEFAULT_GENIGNORE;
  let shaOrBranch = branch || "HEAD";

  // Read entire stream into buffer
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const fullBuffer = new Uint8Array(
    chunks.reduce((acc, chunk) => acc + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    fullBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  let pos = 0;
  while (pos < fullBuffer.length - 4) {
    // Look for local file header signature (PK\x03\x04)
    if (
      fullBuffer[pos] === 0x50 &&
      fullBuffer[pos + 1] === 0x4b &&
      fullBuffer[pos + 2] === 0x03 &&
      fullBuffer[pos + 3] === 0x04
    ) {
      // Parse local file header
      const compressionMethod =
        fullBuffer[pos + 8] | (fullBuffer[pos + 9] << 8);
      const compressedSize =
        fullBuffer[pos + 18] |
        (fullBuffer[pos + 19] << 8) |
        (fullBuffer[pos + 20] << 16) |
        (fullBuffer[pos + 21] << 24);
      const uncompressedSize =
        fullBuffer[pos + 22] |
        (fullBuffer[pos + 23] << 8) |
        (fullBuffer[pos + 24] << 16) |
        (fullBuffer[pos + 25] << 24);
      const fileNameLength = fullBuffer[pos + 26] | (fullBuffer[pos + 27] << 8);
      const extraFieldLength =
        fullBuffer[pos + 28] | (fullBuffer[pos + 29] << 8);

      const fileNameStart = pos + 30;
      const fileName = new TextDecoder().decode(
        fullBuffer.slice(fileNameStart, fileNameStart + fileNameLength),
      );

      const dataStart = fileNameStart + fileNameLength + extraFieldLength;
      const dataEnd = dataStart + compressedSize;

      if (!fileName.endsWith("/")) {
        const filePath = fileName.split("/").slice(1).join("/");

        // Get the raw (possibly compressed) data
        const rawData = fullBuffer.slice(dataStart, dataEnd);

        // Decompress if needed
        let fileData: Uint8Array;
        try {
          if (compressionMethod === 0) {
            // Stored (no compression)
            fileData = rawData;
          } else if (compressionMethod === 8) {
            // DEFLATE compression
            fileData = await inflateRaw(rawData);
          } else {
            // Unsupported compression method - skip this file
            console.warn(
              `Unsupported compression method ${compressionMethod} for ${filePath}`,
            );
            pos = dataEnd;
            continue;
          }
        } catch (e) {
          // Decompression failed - skip this file
          console.warn(`Failed to decompress ${filePath}:`, e);
          pos = dataEnd;
          continue;
        }

        // Handle .genignore file
        if (filePath === ".genignore" && !disableGenignore) {
          try {
            genignoreString = new TextDecoder("utf-8", { fatal: true }).decode(
              fileData,
            );
          } catch {
            // If .genignore isn't valid UTF-8, use default
          }
        }

        if (
          shouldIncludeFile({
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
          // Check if it's valid UTF-8 text
          const isText = isValidUtf8(fileData);

          // Apply max file size filter only to text files
          if (isText && maxFileSize && fileData.length > maxFileSize) {
            pos = dataEnd;
            continue;
          }

          const hash = await calculateHash(fileData);

          if (isText) {
            const content = new TextDecoder("utf-8").decode(fileData);
            fileContents[filePath] = {
              type: "content",
              content,
              hash,
              size: fileData.length,
              url: undefined,
            };
          } else {
            fileContents[filePath] = {
              type: "binary",
              content: undefined,
              hash,
              size: fileData.length,
              url: `https://raw.githubusercontent.com/${owner}/${repo}/${shaOrBranch}/${filePath}`,
            };
          }
        }
      }

      pos = dataEnd;
    } else {
      pos++;
    }
  }

  const genignore =
    genignoreString && !disableGenignore
      ? compileGitignore(genignoreString)
      : undefined;
  const unignoredFilePaths = Object.keys(fileContents).filter((p) =>
    genignore ? genignore.accepts(p) : true,
  );
  const final: { [path: string]: ContentType } = {};
  unignoredFilePaths.forEach((p) => {
    final["/" + p] = fileContents[p];
  });
  return { status: 200, result: final, shaOrBranch };
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
}): string {
  const {
    description,
    fileString,
    title,
    tokens,
    totalLines,
    totalTokens,
    tree,
    url,
    default_branch,
  } = context;
  const [_, owner, repo, page, branch, ...pathParts] = url.pathname.split("/");
  const path = pathParts.join("/");

  // Build the current page URL for LLM links
  const currentPageUrl = encodeURIComponent(
    url.origin + url.pathname + url.search,
  );
  const chatgptUrl = `https://chatgpt.com/?hints=search&prompt=Read+from+${currentPageUrl}+so+I+can+ask+questions+about+it.`;
  const claudeUrl = `https://claude.ai/new?q=Read%20from%20${currentPageUrl}%20so%20I%20can%20ask%20questions%20about%20it.`;

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
    
    /* Copy Menu Button Styles */
    .copy-menu-container {
      position: relative;
    }
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
    .button-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
    }
    .icon {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
    }
    .arrow-icon {
      width: 14px;
      height: 14px;
      transition: transform 0.3s;
    }
    .arrow-icon.rotated {
      transform: rotate(180deg);
    }
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
    .menu.open {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }
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
    .menu-item:last-child {
      border-bottom: none;
    }
    .menu-item:hover {
      background: rgba(255, 255, 255, 0.05);
    }
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
    .menu-icon img {
      width: 24px;
      height: 24px;
      border-radius: 4px;
    }
    .menu-content {
      flex: 1;
    }
    .menu-title {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .menu-description {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.6);
    }
    .external-icon {
      width: 14px;
      height: 14px;
      opacity: 0.6;
    }
    textarea {
      position: absolute;
      left: -9999px;
    }
  </style>
</head>
<body>
  <header>
    <div id="filterContainer">
      <select id="formatSelect" onchange="updateFilters()">
        <option value="text/html">Format: HTML</option>
        <option value="application/json">Format: JSON</option>
        <option value="text/yaml">Format: YAML</option>
        <option value="text/plain">Format: Text</option>
      </select>
      <span style="font-size:12px">max tokens</span>
      <input type="search" id="maxTokensInput" onchange="updateFilters()">
      <select id="extSelect" onchange="updateFilters()"></select>
      <select style="max-width: 200px;" id="locationSelect" onchange="navigateToLocation()"></select>
    </div>
    <div style="flex-direction: row; gap: 20px; display: flex; align-items:center; justify-content: center;">
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
      
      <a href="${url.origin.replace("github.com", "uithub.com")}${
    url.pathname
  }" target="_blank">
        <svg class="github-icon" viewBox="0 0 16 16" version="1.1" width="32" height="32">
          <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </a>
    </div>
  </header>
  <div style="max-width: 100vw; margin-top:35px;">
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
    
    // Copy Menu Functionality
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
      
      setTimeout(() => {
        buttonText.textContent = originalText;
      }, 1000);
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
      url.searchParams.set('accept', format);
      if (maxTokens) {
        url.searchParams.set('maxTokens', maxTokens);
      } else {
        url.searchParams.set('maxTokens', 10000000);
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
      const format = url.searchParams.get('accept') || "text/html";
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

// ==================== LINE NUMBER HELPER ====================

function withLeadingSpace(lineNumber: number, totalLines: number): string {
  const totalCharacters = String(totalLines).length;
  const spacesNeeded = totalCharacters - String(lineNumber).length;
  return " ".repeat(spacesNeeded) + String(lineNumber);
}

function addLineNumbers(
  content: string,
  shouldAddLineNumbers: boolean,
): string {
  if (!shouldAddLineNumbers) return content;
  const lines = content.split("\n");
  return lines
    .map(
      (line, index) => `${withLeadingSpace(index + 1, lines.length)} | ${line}`,
    )
    .join("\n");
}

// ==================== CHECK REPO ACCESS ====================

async function checkRepoAccess(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<{
  exists: boolean;
  isPrivate: boolean;
  default_branch?: string;
}> {
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

// ==================== MAIN HANDLER ====================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle OAuth routes
    if (url.pathname === "/login") {
      const scope = url.searchParams.get("scope") || "user:email";
      return handleLogin(request, env, scope);
    }
    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/logout") {
      return handleLogout(request);
    }

    const [_, owner, repo, page, branch, ...pathParts] =
      url.pathname.split("/");
    const path = pathParts.join("/");
    const apiKey = getAccessToken(request);
    if (apiKey) {
      console.log({ apiKey, owner, repo, page, branch, pathParts });
    }

    // Root - show index.html
    if (!owner) {
      return new Response("Index page", {
        headers: { "Content-Type": "text/html" },
      });
    }

    // User profile page
    if (!repo) {
      try {
        const headers: HeadersInit = {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "uithub",
        };
        if (apiKey) headers["Authorization"] = `token ${apiKey}`;

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
        const acceptHeader =
          url.searchParams.get("accept") || request.headers.get("Accept");
        if (acceptHeader === "text/markdown") {
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

    // Repository content - check access first
    try {
      const repoAccess = await checkRepoAccess(owner, repo, apiKey);

      // If repo doesn't exist or is private and we don't have token, require login
      if (!repoAccess.exists) {
        if (!apiKey) {
          const loginUrl = `${
            url.origin
          }/login?scope=repo&redirect_to=${encodeURIComponent(
            url.pathname + url.search,
          )}`;
          if (request.headers.get("Accept")?.includes("text/html")) {
            return new Response(
              `<!DOCTYPE html>
<html>
<head>
  <title>Login Required</title>
  <style>
    body { font-family: system-ui; background: #1a1a1a; color: #f0f0f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 500px; padding: 40px; background: #2a2a2a; border-radius: 12px; }
    h1 { color: #8b5cf6; margin-bottom: 20px; }
    p { margin-bottom: 30px; opacity: 0.9; }
    a { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: bold; }
    a:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4); }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔒 Private Repository</h1>
    <p>This repository is private or doesn't exist. Please login with GitHub to access it.</p>
    <a href="${loginUrl}">Login with GitHub</a>
  </div>
</body>
</html>`,
              {
                status: 401,
                headers: { "Content-Type": "text/html;charset=utf8" },
              },
            );
          }
          return new Response(
            "Repository not found or private. Authentication required.",
            { status: 401 },
          );
        }
        return new Response("Repository not found", { status: 404 });
      }

      // If repo is private but we only have public scope, require private scope login
      if (repoAccess.isPrivate && apiKey) {
        const user = getCurrentUser(request);
        if (user) {
          const scopeResponse = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `token ${apiKey}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "uithub",
            },
          });
          const scopes = scopeResponse.headers.get("X-OAuth-Scopes") || "";
          if (!scopes.includes("repo")) {
            const loginUrl = `${
              url.origin
            }/login?scope=repo&redirect_to=${encodeURIComponent(
              url.pathname + url.search,
            )}`;
            if (request.headers.get("Accept")?.includes("text/html")) {
              return new Response(
                `<!DOCTYPE html>
<html>
<head>
  <title>Additional Permission Required</title>
  <style>
    body { font-family: system-ui; background: #1a1a1a; color: #f0f0f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 500px; padding: 40px; background: #2a2a2a; border-radius: 12px; }
    h1 { color: #8b5cf6; margin-bottom: 20px; }
    p { margin-bottom: 30px; opacity: 0.9; }
    a { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: bold; }
    a:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4); }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔒 Private Repository Access</h1>
    <p>This repository requires private repository access. Please re-authenticate with the necessary permissions.</p>
    <a href="${loginUrl}">Grant Access</a>
  </div>
</body>
</html>`,
                { status: 403, headers: { "Content-Type": "text/html" } },
              );
            }
            return new Response("Private repository access required", {
              status: 403,
            });
          }
        }
      }

      // Parse query params
      const maxTokensParam = url.searchParams.get("maxTokens");
      const accept =
        url.searchParams.get("accept") || request.headers.get("Accept") || "";
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

      const isJson = accept === "application/json";
      const isYaml = accept === "text/yaml";
      const needStringOrHtml = !isJson && !isYaml;
      const needHtml = accept?.includes("text/html");

      const realMaxTokens =
        maxTokensParam && !isNaN(Number(maxTokensParam))
          ? Number(maxTokensParam)
          : needStringOrHtml
          ? DEFAULT_MAX_TOKENS
          : undefined;

      // Fetch from GitHub
      const ref = branch && branch !== "" ? branch : "HEAD";
      const isPrivate = !!apiKey;
      const branchSuffix = branch && branch !== "" ? `/${branch}` : "";
      const apiUrl = isPrivate
        ? `https://api.github.com/repos/${owner}/${repo}/zipball${branchSuffix}`
        : `https://github.com/${owner}/${repo}/archive/${ref}.zip`;
      const headers: HeadersInit = isPrivate
        ? { Authorization: `token ${apiKey}` }
        : {};
      headers["User-Agent"] = "uithub";
      if (apiKey) {
        console.log({ apiUrl, headers });
      }

      const response = await fetch(apiUrl, { headers });
      if (!response.ok || !response.body) {
        return new Response(`Failed to fetch repository: ${response.status}`, {
          status: response.status,
        });
      }

      // Parse ZIP
      const result = await parseZipStream(response.body, {
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
        shouldOmitFiles,
        disableGenignore,
        maxFileSize,
      });

      if (!result.result) {
        return new Response(result.message || "Error processing repository", {
          status: result.status,
        });
      }

      // Build tree and content
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

      const getPathTokenSize = (path: string) =>
        Math.ceil(stringifyFileContent(path).length / CHARACTERS_PER_TOKEN);

      const getPathLineSize = (path: string) => {
        const item = result.result![path];
        const contentOrUrl =
          item.type === "content"
            ? item.content
            : item.type === "binary"
            ? item.url
            : "";
        return Math.ceil(
          `-----------------------\n${path}:\n-----------------------\n\n${contentOrUrl}`.split(
            "\n",
          ).length,
        );
      };

      let totalTokens: number;
      let totalLines: number;

      // Apply token limit
      if (realMaxTokens) {
        const pathsBySize = Object.keys(result.result).sort(
          (a, b) => getPathTokenSize(a) - getPathTokenSize(b),
        );

        const { lastIndexThatFits, total, lines } = pathsBySize.reduce(
          (previous, current, currentIndex) => {
            const currentTokens = getPathTokenSize(current);
            const currentLines = getPathLineSize(current);
            const newLines = previous.lines + currentLines;
            const newTotal = previous.total + currentTokens;
            if (newTotal > realMaxTokens) {
              return {
                lines: newLines,
                total: newTotal,
                lastIndexThatFits: previous.lastIndexThatFits,
              };
            }
            return {
              total: newTotal,
              lines: newLines,
              lastIndexThatFits: currentIndex,
            };
          },
          { total: 0, lines: 0, lastIndexThatFits: -1 },
        );

        totalTokens = total + treeTokens;
        totalLines = lines;

        const pathsToRemove =
          lastIndexThatFits === -1
            ? []
            : pathsBySize.slice(lastIndexThatFits + 1);
        pathsToRemove.forEach((p) => {
          delete result.result![p];
        });
      } else {
        totalTokens =
          Object.keys(result.result)
            .map(getPathTokenSize)
            .reduce((sum, tokens) => sum + tokens, 0) + treeTokens;
        totalLines = Object.keys(result.result)
          .map(getPathLineSize)
          .reduce((sum, lines) => sum + lines, 0);
      }

      const filePart = Object.keys(result.result)
        .map(stringifyFileContent)
        .join("");
      const fileString =
        treeString + (shouldOmitFiles ? "" : "\n\n" + filePart);
      const tokens = Math.round(
        (treeString + "\n\n" + filePart).length / CHARACTERS_PER_TOKEN,
      );

      // Return HTML
      if (needHtml) {
        const branchPart = branch ? ` at ${branch}` : "";
        const title = `${owner}/${repo} - uithub`;
        const description = `LLM context for ${repo}. /${path}${branchPart} contains ${tokens} tokens.`;

        const viewHtml = generateViewHTML({
          url,
          title,
          description,
          fileString,
          tokens,
          totalTokens,
          totalLines,
          tree,
          default_branch: result.shaOrBranch || repoAccess.default_branch,
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

      // Return text
      if (needStringOrHtml) {
        return new Response(fileString, {
          headers: { "Content-Type": "text/plain" },
        });
      }

      // Return JSON/YAML
      const body = {
        size: {
          tokens,
          totalTokens,
          characters: totalTokens * CHARACTERS_PER_TOKEN,
          lines: totalLines,
        },
        tree: shouldOmitTree ? undefined : tree,
        files: shouldOmitFiles ? undefined : result.result,
      };

      if (isYaml) {
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
