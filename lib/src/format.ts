import {
  CHARACTERS_PER_TOKEN,
  type ContentType,
  type FormatOptions,
  type NestedObject,
  type TokenTree,
} from "./types.js";
import { addLineNumbers } from "./parse-zip.js";

// ==================== TREE UTILITIES ====================

export function filePathToNestedObject<T, U>(
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

export function nestedObjectToTreeString<T>(
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

// ==================== TOKEN TREE UTILITIES ====================

export function calculateFolderTokens(tree: TokenTree): number {
  let total = 0;
  for (const value of Object.values(tree)) {
    if (typeof value === "number") {
      total += value;
    } else {
      total += calculateFolderTokens(value);
    }
  }
  return total;
}

export function processTokenTree(tree: TokenTree): TokenTree {
  const result: TokenTree = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "number") {
      // Keep all files, but round to nearest 100 (or 0 if under 50)
      result[key] = Math.round(value / 100) * 100;
    } else {
      // Recursively process folder
      result[key] = processTokenTree(value);
    }
  }
  return result;
}

export function tokenTreeToString(
  obj: TokenTree,
  prefix: string = "",
  isLast: boolean = true,
): string {
  let result = "";
  const entries = Object.entries(obj);
  entries.forEach(([key, value], index) => {
    const isLastEntry = index === entries.length - 1;
    const newPrefix = prefix + (isLast ? "    " : "│   ");
    if (typeof value === "number") {
      // File: show token count only if > 100
      const tokenSuffix = value > 100 ? ` (${value} tokens)` : "";
      result += `${prefix}${isLastEntry ? "└── " : "├── "}${key}${tokenSuffix}\n`;
    } else {
      // Folder: calculate and show total tokens, rounded to nearest 100
      const folderTokens = Math.round(calculateFolderTokens(value) / 100) * 100;
      const tokenSuffix = folderTokens > 0 ? ` (${folderTokens} tokens)` : "";
      result += `${prefix}${isLastEntry ? "└── " : "├── "}${key}/${tokenSuffix}\n`;
      result += tokenTreeToString(value, newPrefix, isLastEntry);
    }
  });
  return result;
}

// ==================== FILE CONTENT FORMATTING ====================

export function stringifyFileContent(
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

export function calculateFileTokensFromContent(
  path: string,
  item: ContentType,
  shouldAddLineNumbers: boolean,
): number {
  const contentOrUrl =
    item.type === "content"
      ? addLineNumbers(item.content || "", shouldAddLineNumbers)
      : item.type === "binary"
        ? item.url
        : "";
  const fileString = `${path}:\n${"-".repeat(80)}\n${contentOrUrl}\n\n\n${"-".repeat(80)}\n`;
  return Math.round(fileString.length / CHARACTERS_PER_TOKEN);
}

export function filePathToTokenTree(
  flatObject: { [filepath: string]: ContentType },
  shouldAddLineNumbers: boolean,
): TokenTree {
  const result: TokenTree = {};
  for (const [path, value] of Object.entries(flatObject)) {
    let parts = path.split("/");
    parts = parts[0] === "" ? parts.slice(1) : parts;
    let current: TokenTree = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // Leaf node: store token count
        current[part] = calculateFileTokensFromContent(
          path,
          value,
          shouldAddLineNumbers,
        );
      } else {
        current[part] = (current[part] as TokenTree) || {};
        current = current[part] as TokenTree;
      }
    }
  }
  return result;
}

// ==================== MAIN FORMATTING FUNCTION ====================

export interface FormattedOutput {
  tree: NestedObject<null>;
  tokenTree: TokenTree;
  fileString: string;
  tokens: number;
  treeTokens: number;
}

export function formatRepoContent(
  files: { [path: string]: ContentType },
  options: FormatOptions,
): FormattedOutput {
  const { shouldAddLineNumbers, shouldOmitFiles, shouldOmitTree } = options;

  const tree = filePathToNestedObject({ ...files }, () => null);
  const rawTokenTree = filePathToTokenTree(files, shouldAddLineNumbers);
  const tokenTree = processTokenTree(rawTokenTree);
  const treeString = shouldOmitTree ? "" : tokenTreeToString(tokenTree);
  const treeTokens = Math.round(treeString.length / CHARACTERS_PER_TOKEN);

  const filePart = shouldOmitFiles
    ? ""
    : Object.keys(files)
        .map((path) =>
          stringifyFileContent(path, files[path], shouldAddLineNumbers),
        )
        .join("");

  // Build fileString based on what's included
  let fileString: string;
  if (shouldOmitTree && shouldOmitFiles) {
    fileString = "";
  } else if (shouldOmitTree) {
    fileString = filePart;
  } else if (shouldOmitFiles) {
    fileString = treeString;
  } else {
    fileString = treeString + "\n\n" + filePart;
  }

  const tokens = Math.round(fileString.length / CHARACTERS_PER_TOKEN);

  return { tree, tokenTree, fileString, tokens, treeTokens };
}
