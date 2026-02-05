// ==================== CONSTANTS ====================

export const CHARACTERS_PER_TOKEN = 5;

// ==================== TYPES ====================

export type ContentType = {
  type: "content" | "binary";
  content?: string;
  url?: string;
  hash: string;
  size: number;
};

export type NestedObject<T = null> = {
  [key: string]: NestedObject<T> | T;
};

export type TokenTree = {
  [key: string]: TokenTree | number;
};

export interface ParseOptions {
  // Filtering
  includeExt?: string[];
  excludeExt?: string[];
  includeDir?: string[];
  excludeDir?: string[];
  paths?: string[];
  disableGenignore?: boolean;
  maxFileSize?: number;
  maxTokens: number;
  yamlFilter?: string;

  // Glob patterns (VS Code style)
  /** Glob patterns for files to include (e.g., "**\/*.ts", "src/**") */
  include?: string[];
  /** Glob patterns for files to exclude (e.g., "** /node_modules/**", "** /*.test.ts") */
  exclude?: string[];

  // Search options
  /** Search string to filter files by content */
  search?: string;
  /** Whether search should be case-sensitive (default: false) */
  searchMatchCase?: boolean;
  /** Whether search string is a regular expression (default: false) */
  searchRegularExp?: boolean;

  // Formatting
  shouldAddLineNumbers?: boolean;
}

export interface FormatOptions {
  shouldAddLineNumbers: boolean;
  shouldOmitFiles: boolean;
  shouldOmitTree: boolean;
}

export interface UithubResult {
  files: { [path: string]: ContentType };
  tree: NestedObject<null>;
  tokenTree: TokenTree;
  fileString: string;
  tokens: number;
  totalTokens: number;
  totalLines: number;
}

export interface ParsedZipResult {
  status: number;
  result?: { [path: string]: ContentType };
  allPaths?: string[];
  shaOrBranch?: string;
  message?: string;
  totalTokens: number;
  totalLines: number;
  usedTokens: number;
}
