import { parseZipStreaming, type StreamingParseContext } from "./parse-zip.js";
import { formatRepoContent } from "./format.js";
import {
  type ContentType,
  type FormatOptions,
  type NestedObject,
  type ParseOptions,
  type TokenTree,
  type UithubResult,
  CHARACTERS_PER_TOKEN,
} from "./types.js";

// Re-export types
export {
  type ContentType,
  type FormatOptions,
  type NestedObject,
  type ParseOptions,
  type TokenTree,
  type UithubResult,
  type StreamingParseContext,
  CHARACTERS_PER_TOKEN,
};

// Re-export utilities that might be useful
export {
  addLineNumbers,
  calculateFileTokens,
  contentMatchesSearch,
  matchesGlobPatterns,
  parseZipStreaming,
  type SearchOptions,
} from "./parse-zip.js";
export {
  filePathToNestedObject,
  filePathToTokenTree,
  formatRepoContent,
  tokenTreeToString,
} from "./format.js";

// ==================== MAIN API ====================

export interface UithubOptions extends ParseOptions {
  shouldOmitFiles?: boolean;
  shouldOmitTree?: boolean;
}

/**
 * Parse a GitHub repository zip stream and return formatted content optimized for LLMs.
 *
 * @param zipStream - ReadableStream of the zip file
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param branch - Branch name (optional, defaults to HEAD)
 * @param options - Parsing and formatting options
 * @returns Parsed and formatted repository content
 */
export async function parseGitHubZip(
  zipStream: ReadableStream<Uint8Array>,
  owner: string,
  repo: string,
  branch?: string,
  options: UithubOptions = { maxTokens: 50000 },
): Promise<UithubResult> {
  const parseContext: StreamingParseContext = {
    owner,
    repo,
    branch,
    excludeDir: options.excludeDir,
    excludeExt: options.excludeExt,
    includeDir: options.includeDir,
    includeExt: options.includeExt,
    yamlFilter: options.yamlFilter,
    paths: options.paths,
    disableGenignore: options.disableGenignore,
    maxFileSize: options.maxFileSize,
    maxTokens: options.maxTokens,
    shouldAddLineNumbers: options.shouldAddLineNumbers ?? true,
    // Glob patterns (VS Code style)
    include: options.include,
    exclude: options.exclude,
    // Search options
    search: options.search,
    searchMatchCase: options.searchMatchCase,
    searchRegularExp: options.searchRegularExp,
  };

  const parseResult = await parseZipStreaming(zipStream, parseContext);

  if (!parseResult.result) {
    throw new Error(parseResult.message || "Failed to parse zip");
  }

  const formatOptions: FormatOptions = {
    shouldAddLineNumbers: options.shouldAddLineNumbers ?? true,
    shouldOmitFiles: options.shouldOmitFiles ?? false,
    shouldOmitTree: options.shouldOmitTree ?? false,
  };

  const formatted = formatRepoContent(parseResult.result, formatOptions);

  return {
    files: parseResult.result,
    tree: formatted.tree,
    tokenTree: formatted.tokenTree,
    fileString: formatted.fileString,
    tokens: formatted.tokens,
    totalTokens: parseResult.totalTokens + formatted.treeTokens,
    totalLines: parseResult.totalLines,
  };
}
