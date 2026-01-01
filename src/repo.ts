import { stringify } from "yaml";
import {
  type Env,
  type UserAccount,
  getUserAccount,
  setUserAccount,
  createUnauthorizedResponse,
  getUser,
} from "./auth";
import {
  parseZipStreaming,
  addLineNumbers,
  CHARACTERS_PER_TOKEN,
  type ContentType,
  type StreamingParseContext,
} from "./parse-zip";

// ==================== CONSTANTS ====================

const DEFAULT_MAX_TOKENS = 50000;
const PRIVATE_REPO_COST_CENTS = 1; // $0.01

// ==================== TYPES ====================

type NestedObject<T = null> = {
  [key: string]: NestedObject<T> | T;
};

type ModalState =
  | "login_required"
  | "private_access_required"
  | "credit_required"
  | null;

interface ResponseFormat {
  type: "html" | "json" | "yaml" | "markdown";
}

interface RepoRequestParams {
  maxTokens: number;
  shouldAddLineNumbers: boolean;
  includeExt?: string[];
  includeDir?: string[];
  excludeExt?: string[];
  excludeDir?: string[];
  disableGenignore: boolean;
  maxFileSize?: number;
  yamlFilter?: string;
  shouldOmitFiles: boolean;
  shouldOmitTree: boolean;
  matchFilenames?: string[];
}

interface ModalContext {
  loginUrl: string;
  privateAccessUrl: string;
  paymentLink: string | null;
  credit: number;
  username?: string;
  profilePicture?: string;
}

interface RepoAccess {
  exists: boolean;
  isPrivate: boolean;
  default_branch?: string;
}

// ==================== UTILITY FUNCTIONS ====================

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

// ==================== MODAL STATE LOGIC ====================

function determineModalState(
  currentUser: any,
  sessionScopes: string,
  userAccount: UserAccount | null,
  repoAccess: RepoAccess,
): ModalState {
  if (!currentUser) return "login_required";

  if (!repoAccess.exists || repoAccess.isPrivate) {
    if (!sessionScopes.includes("repo")) {
      return "private_access_required";
    }
    if (!userAccount || userAccount.credit < PRIVATE_REPO_COST_CENTS) {
      return "credit_required";
    }
  }

  return null;
}

// ==================== URL BUILDERS ====================

function buildModalContextUrls(
  url: URL,
  env: Env,
  currentUser: any,
): { loginUrl: string; privateAccessUrl: string; paymentLink: string | null } {
  const redirectParams = `resource=${encodeURIComponent(
    url.origin,
  )}&redirect_to=${encodeURIComponent(url.pathname + url.search)}`;
  const loginUrl = `${url.origin}/login?scope=user:email&${redirectParams}`;
  const privateAccessUrl = `${url.origin}/login?scope=repo&${redirectParams}`;
  const paymentLink = currentUser
    ? `${env.STRIPE_PAYMENT_LINK}?client_reference_id=${currentUser.id}`
    : null;

  return { loginUrl, privateAccessUrl, paymentLink };
}

// ==================== QUERY PARAMETER PARSING ====================

function parseRepoRequestParams(url: URL): RepoRequestParams {
  const maxTokensParam = url.searchParams.get("maxTokens");
  return {
    maxTokens:
      maxTokensParam && !isNaN(Number(maxTokensParam))
        ? Number(maxTokensParam)
        : DEFAULT_MAX_TOKENS,
    shouldAddLineNumbers: url.searchParams.get("lines") !== "false",
    includeExt: url.searchParams.get("ext")?.split(","),
    includeDir: url.searchParams.get("dir")?.split(","),
    excludeExt: url.searchParams.get("exclude-ext")?.split(","),
    excludeDir: url.searchParams.get("exclude-dir")?.split(","),
    disableGenignore: url.searchParams.get("disableGenignore") === "true",
    maxFileSize:
      parseInt(url.searchParams.get("maxFileSize") || "0", 10) || undefined,
    yamlFilter: url.searchParams.get("yamlFilter") || undefined,
    shouldOmitFiles: url.searchParams.get("omitFiles") === "true",
    shouldOmitTree: url.searchParams.get("omitTree") === "true",
    matchFilenames: url.searchParams
      .get("matchFilenames")
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

// ==================== RESPONSE FORMAT ====================

function determineResponseFormat(request: Request, url: URL): ResponseFormat {
  const acceptParam = url.searchParams.get("accept");
  const acceptHeader = request.headers.get("Accept") || "";

  if (acceptParam) {
    if (acceptParam === "application/json") return { type: "json" };
    if (acceptParam === "text/yaml") return { type: "yaml" };
    if (acceptParam === "text/plain" || acceptParam === "text/markdown")
      return { type: "markdown" };
  }

  if (acceptHeader === "*/*" || acceptHeader === "")
    return { type: "markdown" };
  if (acceptHeader.includes("text/html")) return { type: "html" };
  if (acceptHeader.includes("application/json")) return { type: "json" };
  if (acceptHeader.includes("text/yaml")) return { type: "yaml" };
  if (
    acceptHeader.includes("text/plain") ||
    acceptHeader.includes("text/markdown")
  )
    return { type: "markdown" };

  return { type: "markdown" };
}

// ==================== REPO ACCESS ====================

async function checkRepoAccess(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<RepoAccess> {
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

// ==================== TREE AND FILE STRING BUILDING ====================

function stringifyFileContent(
  path: string,
  item: ContentType,
  shouldAddLineNumbers: boolean,
): string {
  const contentOrUrl =
    item.type === "content"
      ? addLineNumbers(item.content || "", shouldAddLineNumbers)
      : item.type === "binary"
      ? item.url
      : "";
  return `${path}:\n${"-".repeat(80)}\n${contentOrUrl}\n\n\n${"-".repeat(
    80,
  )}\n`;
}

function buildTreeAndFileString(
  result: { [path: string]: ContentType },
  shouldOmitFiles: boolean,
  shouldAddLineNumbers: boolean,
): {
  tree: NestedObject<null>;
  fileString: string;
  tokens: number;
  treeTokens: number;
} {
  const tree = filePathToNestedObject({ ...result }, () => null);
  const treeString = nestedObjectToTreeString(tree);
  const treeTokens = Math.round(treeString.length / CHARACTERS_PER_TOKEN);

  const filePart = shouldOmitFiles
    ? ""
    : Object.keys(result)
        .map((path) =>
          stringifyFileContent(path, result[path], shouldAddLineNumbers),
        )
        .join("");

  const fileString = treeString + (shouldOmitFiles ? "" : "\n\n" + filePart);
  const tokens = Math.round(
    (treeString + "\n\n" + filePart).length / CHARACTERS_PER_TOKEN,
  );

  return { tree, fileString, tokens, treeTokens };
}

// ==================== MODAL HTML GENERATION ====================

function generateModalHTML(state: ModalState, context: ModalContext): string {
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
  modalContext: ModalContext;
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
    }
    .copy-button:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .icon { 
      width: 16px; 
      height: 16px; 
      stroke: currentColor; 
      fill: none; 
      stroke-width: 2; 
    }
    textarea { 
      position: absolute; 
      left: -9999px; 
    }
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
          <a href="/dashboard" target="_blank" style="text-decoration:none;">
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
      
      <button class="copy-button" id="copyButton">
        <svg class="icon" viewBox="0 0 24 24">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span id="buttonText">Copy page</span>
      </button>
      
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
    
    const copyButton = document.getElementById('copyButton');
    const buttonText = document.getElementById('buttonText');
    const copyContent = document.getElementById('copyContent');
    
    copyButton.addEventListener('click', () => {
      copyContent.select();
      document.execCommand('copy');
      const originalText = buttonText.textContent;
      buttonText.textContent = 'Copied';
      setTimeout(() => { buttonText.textContent = originalText; }, 1000);
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
      
      if (maxTokens && maxTokens.trim() !== '') {
        url.searchParams.set('maxTokens', maxTokens);
      } else {
        // Set to large default instead of deleting
        url.searchParams.set('maxTokens', '10000000'); 
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

// ==================== RESPONSE BUILDERS ====================

function buildUnauthorizedResponse(
  modalState: ModalState,
  url: URL,
  modalContext: ModalContext,
): Response {
  if (modalState === "login_required") {
    return createUnauthorizedResponse(url, "read");
  } else if (modalState === "private_access_required") {
    return new Response(
      "Private repository access required. Please authenticate with 'repo' scope.",
      {
        status: 403,
        headers: {
          "WWW-Authenticate": `Bearer realm="${url.hostname}", resource_metadata="${url.origin}/.well-known/oauth-protected-resource", scope="repo"`,
        },
      },
    );
  } else {
    return new Response(
      `Insufficient credit. Balance: $${(
        (modalContext.credit || 0) / 100
      ).toFixed(2)}. Required: $0.01`,
      { status: 402 },
    );
  }
}

function buildPlaceholderHtmlResponse(context: {
  url: URL;
  owner: string;
  repo: string;
  branch?: string;
  path: string;
  repoAccess: RepoAccess;
  modalState: ModalState;
  modalContext: ModalContext;
}): Response {
  const {
    url,
    owner,
    repo,
    branch,
    path,
    repoAccess,
    modalState,
    modalContext,
  } = context;

  const placeholderFileString =
    modalState === "login_required"
      ? "Content hidden. Please sign in to continue."
      : "Content hidden. Please complete the required steps first.";
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

async function fetchAndProcessRepo(
  owner: string,
  repo: string,
  branch: string | undefined,
  path: string,
  githubAccessToken: string | null,
  repoAccess: RepoAccess,
  params: RepoRequestParams,
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
    return {
      status: response.status,
      message: `Failed to fetch repository: ${response.status}`,
      totalTokens: 0,
      totalLines: 0,
      usedTokens: 0,
    };
  }

  const parseContext: StreamingParseContext = {
    owner,
    repo,
    branch,
    excludeDir: params.excludeDir,
    excludeExt: params.excludeExt,
    includeDir: params.includeDir,
    includeExt: params.includeExt,
    yamlFilter: params.yamlFilter,
    matchFilenames: params.matchFilenames,
    paths: path ? [path] : undefined,
    disableGenignore: params.disableGenignore,
    maxFileSize: params.maxFileSize,
    maxTokens: params.maxTokens,
    shouldAddLineNumbers: params.shouldAddLineNumbers,
  };

  return await parseZipStreaming(response.body, parseContext);
}

function buildSuccessResponse(
  format: ResponseFormat,
  result: {
    result: { [path: string]: ContentType };
    totalTokens: number;
    totalLines: number;
    shaOrBranch?: string;
  },
  params: RepoRequestParams,
  url: URL,
  owner: string,
  repo: string,
  branch: string | undefined,
  path: string,
  repoAccess: RepoAccess,
  modalContext: ModalContext,
): Response {
  const { tree, fileString, tokens, treeTokens } = buildTreeAndFileString(
    result.result,
    params.shouldOmitFiles,
    params.shouldAddLineNumbers,
  );

  if (format.type === "html") {
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

  if (format.type === "markdown") {
    return new Response(fileString, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  const body = {
    size: {
      tokens,
      totalTokens: result.totalTokens + treeTokens,
      characters: (result.totalTokens + treeTokens) * CHARACTERS_PER_TOKEN,
      lines: result.totalLines,
    },
    tree: params.shouldOmitTree ? undefined : tree,
    files: params.shouldOmitFiles ? undefined : result.result,
  };

  if (format.type === "yaml") {
    return new Response(stringify(body), {
      headers: { "Content-Type": "text/yaml" },
    });
  }

  return new Response(JSON.stringify(body, undefined, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

// ==================== MAIN HANDLER ====================

export async function handleRepoEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const [_, owner, repo, page, branch, ...pathParts] = url.pathname.split("/");
  const path = pathParts.join("/");

  const { currentUser, githubAccessToken, sessionScopes } = await getUser(
    request,
    env,
  );
  const responseFormat = determineResponseFormat(request, url);

  // Check repo access
  const repoAccess = await checkRepoAccess(owner, repo, githubAccessToken);
  const userAccount = currentUser
    ? await getUserAccount(String(currentUser.id), env)
    : null;

  // Build modal context
  const { loginUrl, privateAccessUrl, paymentLink } = buildModalContextUrls(
    url,
    env,
    currentUser,
  );
  const modalContext: ModalContext = {
    loginUrl,
    privateAccessUrl,
    paymentLink,
    credit: userAccount?.credit || 0,
    username: currentUser?.login,
    profilePicture: currentUser?.avatar_url,
  };

  // Determine modal state
  const modalState = determineModalState(
    currentUser,
    sessionScopes,
    userAccount,
    repoAccess,
  );

  // Handle unauthorized states
  if (modalState && responseFormat.type !== "html") {
    return buildUnauthorizedResponse(modalState, url, modalContext);
  }

  // If HTML and modal state, show placeholder
  if (modalState && responseFormat.type === "html") {
    return buildPlaceholderHtmlResponse({
      url,
      owner,
      repo,
      branch,
      path,
      repoAccess,
      modalState,
      modalContext,
    });
  }

  // Charge for private repo access
  if (
    (!repoAccess.exists || repoAccess.isPrivate) &&
    userAccount &&
    sessionScopes.includes("repo")
  ) {
    const chargeResult = await chargeForPrivateRepo(
      String(currentUser.id),
      env,
    );
    if (!chargeResult.success) {
      return new Response(chargeResult.message, { status: 402 });
    }
  }

  // Fetch and process repo
  const params = parseRepoRequestParams(url);

  try {
    const result = await fetchAndProcessRepo(
      owner,
      repo,
      branch,
      path,
      githubAccessToken,
      repoAccess,
      params,
    );

    if (!result.result) {
      return new Response(result.message || "Error processing repository", {
        status: result.status,
      });
    }

    // Build and return response
    return buildSuccessResponse(
      responseFormat,
      result as any,
      params,
      url,
      owner,
      repo,
      branch,
      path,
      repoAccess,
      modalContext,
    );
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
}
