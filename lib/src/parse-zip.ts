import { parse as parseYaml } from "yaml";
import {
  CHARACTERS_PER_TOKEN,
  type ContentType,
  type ParseOptions,
  type ParsedZipResult,
} from "./types";

// ==================== CONSTANTS ====================

export const DEFAULT_GENIGNORE = `package-lock.json
build
node_modules
`;

// ZIP signatures
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIR_HEADER = 0x02014b50;

// ==================== INTERNAL TYPES ====================

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

// ==================== GLOB PATTERN MATCHING ====================

/**
 * Converts a glob pattern to a regular expression.
 * Supports:
 * - * matches any single path segment (not /)
 * - ** matches any number of path segments (including /)
 * - ? matches any single character
 * - [abc] matches any character in brackets
 * - [!abc] or [^abc] matches any character not in brackets
 * - {a,b,c} matches any of the alternatives
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  // Normalize pattern: remove leading ./ if present
  if (pattern.startsWith("./")) {
    pattern = pattern.slice(2);
  }

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** - matches any path segments
        if (pattern[i + 2] === "/") {
          // **/  matches zero or more directories
          regexStr += "(?:.+/)?";
          i += 3;
        } else if (i + 2 === pattern.length) {
          // ** at end matches everything
          regexStr += ".*";
          i += 2;
        } else {
          // ** in middle
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * - matches any single path segment (not /)
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === "[") {
      // Character class
      let j = i + 1;
      let charClass = "[";
      if (pattern[j] === "!" || pattern[j] === "^") {
        charClass += "^";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\") {
          charClass += "\\" + (pattern[j + 1] || "");
          j += 2;
        } else {
          charClass += pattern[j];
          j++;
        }
      }
      charClass += "]";
      regexStr += charClass;
      i = j + 1;
    } else if (char === "{") {
      // Brace expansion {a,b,c}
      let j = i + 1;
      const alternatives: string[] = [];
      let current = "";
      let depth = 1;
      while (j < pattern.length && depth > 0) {
        if (pattern[j] === "{") {
          depth++;
          current += pattern[j];
        } else if (pattern[j] === "}") {
          depth--;
          if (depth === 0) {
            alternatives.push(current);
          } else {
            current += pattern[j];
          }
        } else if (pattern[j] === "," && depth === 1) {
          alternatives.push(current);
          current = "";
        } else {
          current += pattern[j];
        }
        j++;
      }
      regexStr +=
        "(?:" + alternatives.map((alt) => escapeRegexChar(alt)).join("|") + ")";
      i = j;
    } else if ("/\\.+^$|()".includes(char)) {
      // Escape special regex characters
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  return new RegExp("^" + regexStr + "$");
}

function escapeRegexChar(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a file path matches any of the given glob patterns.
 */
export function matchesGlobPatterns(
  filePath: string,
  patterns: string[],
): boolean {
  // Normalize path: remove leading / if present
  const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

  for (const pattern of patterns) {
    const regex = globToRegex(pattern);
    if (regex.test(normalizedPath)) {
      return true;
    }
  }
  return false;
}

// ==================== SEARCH UTILITIES ====================

export interface SearchOptions {
  search?: string;
  searchMatchCase?: boolean;
  searchRegularExp?: boolean;
}

/**
 * Check if content matches the search criteria.
 */
export function contentMatchesSearch(
  content: string,
  options: SearchOptions,
): boolean {
  if (!options.search) return true;

  if (options.searchRegularExp) {
    try {
      const flags = options.searchMatchCase ? "g" : "gi";
      const regex = new RegExp(options.search, flags);
      return regex.test(content);
    } catch {
      // Invalid regex, treat as literal string
      return contentMatchesLiteral(content, options.search, options.searchMatchCase);
    }
  } else {
    return contentMatchesLiteral(content, options.search, options.searchMatchCase);
  }
}

function contentMatchesLiteral(
  content: string,
  search: string,
  matchCase?: boolean,
): boolean {
  if (matchCase) {
    return content.includes(search);
  } else {
    return content.toLowerCase().includes(search.toLowerCase());
  }
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
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ==================== LINE NUMBERS ====================

export function addLineNumbers(
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

export function calculateFileTokens(
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

  writer.write(compressedData as unknown as BufferSource);
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

// ==================== MAIN ZIP PROCESSOR ====================

export interface StreamingParseContext extends ParseOptions {
  owner: string;
  repo: string;
  branch?: string;
}

export async function parseZipStreaming(
  stream: ReadableStream<Uint8Array>,
  context: StreamingParseContext,
): Promise<ParsedZipResult> {
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
    shouldAddLineNumbers = true,
    // Glob patterns
    include,
    exclude,
    // Search options
    search,
    searchMatchCase,
    searchRegularExp,
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

      // Apply glob include patterns - if specified, file must match at least one
      if (include && include.length > 0) {
        if (!matchesGlobPatterns(filePath, include)) {
          await entry.getData();
          continue;
        }
      }

      // Apply glob exclude patterns - if file matches any, skip it
      if (exclude && exclude.length > 0) {
        if (matchesGlobPatterns(filePath, exclude)) {
          await entry.getData();
          continue;
        }
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

  const searchOptions: SearchOptions = {
    search,
    searchMatchCase,
    searchRegularExp,
  };

  for (const [filePath, { data, isText }] of allFiles) {
    if (genignore && !genignore.accepts(filePath)) {
      continue;
    }

    const hash = await calculateHash(data);

    if (isText) {
      const content = new TextDecoder("utf-8").decode(data);

      // Apply search filter - skip files that don't match
      if (search && !contentMatchesSearch(content, searchOptions)) {
        continue;
      }
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
