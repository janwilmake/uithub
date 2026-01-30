import { DurableObject } from "cloudflare:workers";
import type { Env } from "./auth";

const ALARM_DELAY_MS = 30 * 1000; // 30 seconds
const MAX_TEXT_SIZE = 2 * 1024 * 1024; // 2MB
const CHARACTERS_PER_TOKEN = 5;

export interface FileRecord {
  path: string;
  content: string | null;
  is_binary: boolean;
  url: string | null;
  size: number;
  tokens: number;
}

export class FileDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.initializeDatabase();
  }

  private initializeDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content TEXT,
        is_binary INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_path ON files(path)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tokens ON files(tokens)`);
  }

  private async resetAlarm() {
    await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
  }

  async alarm() {
    // Self-destruct: delete all files
    this.sql.exec("DELETE FROM files");
  }

  async isPopulated(): Promise<boolean> {
    const result = this.sql
      .exec("SELECT COUNT(*) as count FROM files")
      .toArray();
    return (result[0]?.count as number) > 0;
  }

  // Handle fetch for receiving ZIP stream
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/populate") {
      const owner = url.searchParams.get("owner") || "";
      const repo = url.searchParams.get("repo") || "";
      const branch = url.searchParams.get("branch") || "HEAD";

      if (!request.body) {
        return new Response("No body provided", { status: 400 });
      }

      await this.populateFromZip(request.body, owner, repo, branch);
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  private async populateFromZip(
    stream: ReadableStream<Uint8Array>,
    owner: string,
    repo: string,
    branch: string,
  ) {
    // Clear existing
    this.sql.exec("DELETE FROM files");

    const shaOrBranch = branch || "HEAD";

    // Parse ZIP and insert files directly
    const zipReader = new StreamingZipReader(stream);

    try {
      for await (const entry of zipReader.entries()) {
        if (entry.fileName.endsWith("/")) continue;

        const filePath = "/" + entry.fileName.split("/").slice(1).join("/");
        if (filePath === "/") continue;

        const data = await entry.getData();
        if (!data) continue;

        const isText = isValidUtf8(data);
        const size = data.length;

        if (isText && size < MAX_TEXT_SIZE) {
          // Text file - store content
          const content = new TextDecoder("utf-8").decode(data);
          const tokens = Math.ceil(
            (filePath + ":\n" + "-".repeat(80) + "\n" + content + "\n\n\n" + "-".repeat(80) + "\n").length / CHARACTERS_PER_TOKEN
          );

          this.sql.exec(
            "INSERT OR REPLACE INTO files (path, content, is_binary, url, size, tokens) VALUES (?, ?, 0, NULL, ?, ?)",
            filePath,
            content,
            size,
            tokens,
          );
        } else {
          // Binary or large file - store URL only
          const fileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${shaOrBranch}${filePath}`;
          const tokens = Math.ceil(
            (filePath + ":\n" + "-".repeat(80) + "\n" + fileUrl + "\n\n\n" + "-".repeat(80) + "\n").length / CHARACTERS_PER_TOKEN
          );

          this.sql.exec(
            "INSERT OR REPLACE INTO files (path, content, is_binary, url, size, tokens) VALUES (?, NULL, 1, ?, ?, ?)",
            filePath,
            fileUrl,
            size,
            tokens,
          );
        }
      }
    } catch (e) {
      // Stream might have ended early, continue with what we have
    }

    await this.resetAlarm();
  }

  async searchFiles(options?: {
    includeExt?: string[];
    excludeExt?: string[];
    includeDir?: string[];
    excludeDir?: string[];
    paths?: string[];
    search?: string;
    searchMatchCase?: boolean;
    searchRegularExp?: boolean;
    include?: string[];
    exclude?: string[];
    matchFilenames?: string[];
    maxTokens?: number;
  }): Promise<FileRecord[]> {
    await this.resetAlarm();

    // Build SQL query with as much filtering as possible
    let query = "SELECT path, content, is_binary, url, size, tokens FROM files WHERE 1=1";
    const params: any[] = [];

    // Path prefix filter (most selective, do first)
    if (options?.paths?.length) {
      const pathConditions = options.paths.map(() => "path LIKE ?").join(" OR ");
      query += ` AND (${pathConditions})`;
      options.paths.forEach(p => params.push("/" + p + "%"));
    }

    // Extension filters via SQL LIKE
    if (options?.includeExt?.length) {
      const extConditions = options.includeExt.map(() => "path LIKE ?").join(" OR ");
      query += ` AND (${extConditions})`;
      options.includeExt.forEach(ext => params.push("%." + ext));
    }

    if (options?.excludeExt?.length) {
      options.excludeExt.forEach(ext => {
        query += " AND path NOT LIKE ?";
        params.push("%." + ext);
      });
    }

    // Directory filters
    if (options?.includeDir?.length) {
      const dirConditions = options.includeDir.map(() => "path LIKE ?").join(" OR ");
      query += ` AND (${dirConditions})`;
      options.includeDir.forEach(d => params.push("/" + d + "%"));
    }

    if (options?.excludeDir?.length) {
      options.excludeDir.forEach(d => {
        query += " AND path NOT LIKE ?";
        params.push("/" + d + "%");
      });
    }

    // Content search filter (only for text files)
    if (options?.search && !options.searchRegularExp) {
      // Simple case-insensitive search can be done in SQL
      query += " AND is_binary = 0 AND content LIKE ?";
      params.push("%" + options.search + "%");
    }

    // Order by tokens (smallest first) to maximize files in budget
    query += " ORDER BY tokens ASC";

    // Execute query - get paths and metadata first (not content) to stay memory-efficient
    const metaQuery = query.replace(
      "SELECT path, content, is_binary, url, size, tokens",
      "SELECT path, is_binary, url, size, tokens"
    );

    const allMeta = this.sql.exec(metaQuery, ...params).toArray() as Array<{
      path: string;
      is_binary: number;
      url: string | null;
      size: number;
      tokens: number;
    }>;

    // Apply JS-only filters on metadata (glob patterns, regex search, filename match)
    let filteredMeta = allMeta;

    // Filename matching
    if (options?.matchFilenames?.length) {
      filteredMeta = filteredMeta.filter((f) => {
        const filename = f.path.split("/").pop()?.toLowerCase() || "";
        return options.matchFilenames!.some(
          (name) => name.toLowerCase() === filename,
        );
      });
    }

    // Glob patterns (include)
    if (options?.include?.length) {
      filteredMeta = filteredMeta.filter((f) =>
        matchesGlobPatterns(f.path.slice(1), options.include!),
      );
    }

    // Glob patterns (exclude)
    if (options?.exclude?.length) {
      filteredMeta = filteredMeta.filter(
        (f) => !matchesGlobPatterns(f.path.slice(1), options.exclude!),
      );
    }

    // Select files within token budget
    const maxTokens = options?.maxTokens ?? Number.MAX_SAFE_INTEGER;
    const selectedPaths: string[] = [];
    let usedTokens = 0;

    for (const file of filteredMeta) {
      if (usedTokens + file.tokens <= maxTokens) {
        selectedPaths.push(file.path);
        usedTokens += file.tokens;
      }
    }

    if (selectedPaths.length === 0) {
      return [];
    }

    // Fetch full content in batches to avoid SQLite variable limit (100)
    const BATCH_SIZE = 99;
    const results: Array<{
      path: string;
      content: string | null;
      is_binary: number;
      url: string | null;
      size: number;
      tokens: number;
    }> = [];

    for (let i = 0; i < selectedPaths.length; i += BATCH_SIZE) {
      const batch = selectedPaths.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const contentQuery = `SELECT path, content, is_binary, url, size, tokens FROM files WHERE path IN (${placeholders})`;
      const batchResults = this.sql.exec(contentQuery, ...batch).toArray() as typeof results;
      results.push(...batchResults);
    }

    // Sort by tokens (smallest first) after batching
    results.sort((a, b) => a.tokens - b.tokens);

    // Apply regex search if needed (must be done on content)
    let finalResults = results;
    if (options?.search && options.searchRegularExp) {
      finalResults = results.filter((f) => {
        if (f.is_binary || !f.content) return false;
        return contentMatchesSearch(f.content, {
          search: options.search,
          searchMatchCase: options.searchMatchCase,
          searchRegularExp: options.searchRegularExp,
        });
      });
    }

    return finalResults.map((f) => ({
      path: f.path,
      content: f.content,
      is_binary: f.is_binary === 1,
      url: f.url,
      size: f.size,
      tokens: f.tokens,
    }));
  }

  async getAllPaths(): Promise<string[]> {
    await this.resetAlarm();
    const rows = this.sql.exec("SELECT path FROM files ORDER BY path").toArray();
    return rows.map((r: any) => r.path as string);
  }

  async getFileCount(): Promise<number> {
    const result = this.sql
      .exec("SELECT COUNT(*) as count FROM files")
      .toArray();
    return result[0]?.count as number;
  }

  async getTotalTokens(): Promise<number> {
    const result = this.sql
      .exec("SELECT SUM(tokens) as total FROM files")
      .toArray();
    return (result[0]?.total as number) || 0;
  }
}

// ==================== ZIP PARSING ====================

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIR_HEADER = 0x02014b50;

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

function isValidUtf8(data: Uint8Array): boolean {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(data);
    return true;
  } catch {
    return false;
  }
}

// Glob pattern matching utilities
function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  if (pattern.startsWith("./")) {
    pattern = pattern.slice(2);
  }

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
        } else if (i + 2 === pattern.length) {
          regexStr += ".*";
          i += 2;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === "[") {
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
        "(?:" +
        alternatives.map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
        ")";
      i = j;
    } else if ("/\\.+^$|()".includes(char)) {
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  return new RegExp("^" + regexStr + "$");
}

function matchesGlobPatterns(filePath: string, patterns: string[]): boolean {
  const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

  for (const pattern of patterns) {
    const regex = globToRegex(pattern);
    if (regex.test(normalizedPath)) {
      return true;
    }
  }
  return false;
}

function contentMatchesSearch(
  content: string,
  options: {
    search?: string;
    searchMatchCase?: boolean;
    searchRegularExp?: boolean;
  },
): boolean {
  if (!options.search) return true;

  if (options.searchRegularExp) {
    try {
      const flags = options.searchMatchCase ? "g" : "gi";
      const regex = new RegExp(options.search, flags);
      return regex.test(content);
    } catch {
      return contentMatchesLiteral(
        content,
        options.search,
        options.searchMatchCase,
      );
    }
  } else {
    return contentMatchesLiteral(
      content,
      options.search,
      options.searchMatchCase,
    );
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
