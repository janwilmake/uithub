import { parse as parseYaml, stringify } from "yaml";
import {
  type Env,
  type UserAccount,
  getUserAccount,
  setUserAccount,
  createUnauthorizedResponse,
  getUser,
} from "./auth";

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

// ==================== TYPES ====================

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

type ModalState =
  | "login_required"
  | "private_access_required"
  | "credit_required"
  | null;

interface ResponseFormat {
  type: "html" | "json" | "yaml" | "markdown";
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

// ==================== STREAMING ZIP PROCESSOR ====================

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

// ==================== MODAL HTML GENERATION ====================

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

function determineResponseFormat(request: Request, url: URL): ResponseFormat {
  const acceptParam = url.searchParams.get("accept");
  const acceptHeader = request.headers.get("Accept") || "";

  if (acceptParam) {
    if (acceptParam === "application/json") {
      return { type: "json" };
    }
    if (acceptParam === "text/yaml") {
      return { type: "yaml" };
    }
    if (acceptParam === "text/plain" || acceptParam === "text/markdown") {
      return { type: "markdown" };
    }
  }

  if (acceptHeader === "*/*" || acceptHeader === "") {
    return { type: "markdown" };
  }

  if (acceptHeader.includes("text/html")) {
    return { type: "html" };
  }

  if (acceptHeader.includes("application/json")) {
    return { type: "json" };
  }

  if (acceptHeader.includes("text/yaml")) {
    return { type: "yaml" };
  }

  if (
    acceptHeader.includes("text/plain") ||
    acceptHeader.includes("text/markdown")
  ) {
    return { type: "markdown" };
  }

  return { type: "markdown" };
}

// ==================== MAIN HANDLER ====================

export async function handleRepoEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const [_, owner, repo, page, branch, ...pathParts] = url.pathname.split("/");
  const path = pathParts.join("/");

  // Get authentication
  const { currentUser, githubAccessToken, sessionScopes } = await getUser(
    request,
    env,
  );

  const responseFormat = determineResponseFormat(request, url);

  // Repository content - authentication required
  if (!currentUser) {
    if (responseFormat.type === "html") {
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
      return createUnauthorizedResponse(url, "read");
    }
  }

  // User is authenticated, check repo access
  try {
    const repoAccess = await checkRepoAccess(owner, repo, githubAccessToken);

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

    let modalState: ModalState = null;

    if (!repoAccess.exists || repoAccess.isPrivate) {
      if (!sessionScopes.includes("repo")) {
        if (responseFormat.type === "html") {
          modalState = "private_access_required";
        } else {
          return new Response(
            "Private repository access required. Please authenticate with 'repo' scope.",
            {
              status: 403,
              headers: {
                "WWW-Authenticate": `Bearer realm="${url.hostname}", resource_metadata="${url.origin}/.well-known/oauth-protected-resource", scope="repo"`,
              },
            },
          );
        }
      } else if (!userAccount || userAccount.credit < PRIVATE_REPO_COST_CENTS) {
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

    // Stream-parse ZIP
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

    // Build tree
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
    const fileString = treeString + (shouldOmitFiles ? "" : "\n\n" + filePart);
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
      return new Response(stringify(body), {
        headers: { "Content-Type": "text/yaml" },
      });
    }

    return new Response(JSON.stringify(body, undefined, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
}
