import { CHARACTERS_PER_TOKEN, } from "./types";
import { addLineNumbers } from "./parse-zip";
// ==================== TREE UTILITIES ====================
export function filePathToNestedObject(flatObject, mapper) {
    const result = {};
    for (const [path, value] of Object.entries(flatObject)) {
        let parts = path.split("/");
        parts = parts[0] === "" ? parts.slice(1) : parts;
        let current = result;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                current[part] = mapper(value);
            }
            else {
                current[part] = current[part] || {};
                current = current[part];
            }
        }
    }
    return result;
}
export function nestedObjectToTreeString(obj, prefix = "", isLast = true) {
    let result = "";
    const entries = Object.entries(obj);
    entries.forEach(([key, value], index) => {
        const isLastEntry = index === entries.length - 1;
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        result += `${prefix}${isLastEntry ? "└── " : "├── "}${key}\n`;
        if (typeof value === "object" && value !== null) {
            result += nestedObjectToTreeString(value, newPrefix, isLastEntry);
        }
    });
    return result;
}
// ==================== TOKEN TREE UTILITIES ====================
export function calculateFolderTokens(tree) {
    let total = 0;
    for (const value of Object.values(tree)) {
        if (typeof value === "number") {
            total += value;
        }
        else {
            total += calculateFolderTokens(value);
        }
    }
    return total;
}
export function processTokenTree(tree) {
    const result = {};
    for (const [key, value] of Object.entries(tree)) {
        if (typeof value === "number") {
            // Keep all files, but round to nearest 100 (or 0 if under 50)
            result[key] = Math.round(value / 100) * 100;
        }
        else {
            // Recursively process folder
            result[key] = processTokenTree(value);
        }
    }
    return result;
}
export function tokenTreeToString(obj, prefix = "", isLast = true) {
    let result = "";
    const entries = Object.entries(obj);
    entries.forEach(([key, value], index) => {
        const isLastEntry = index === entries.length - 1;
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        if (typeof value === "number") {
            // File: show token count only if > 100
            const tokenSuffix = value > 100 ? ` (${value} tokens)` : "";
            result += `${prefix}${isLastEntry ? "└── " : "├── "}${key}${tokenSuffix}\n`;
        }
        else {
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
export function stringifyFileContent(path, item, shouldAddLineNumbers) {
    const contentOrUrl = item.type === "content"
        ? addLineNumbers(item.content || "", shouldAddLineNumbers)
        : item.type === "binary"
            ? item.url
            : "";
    return `${path}:\n${"-".repeat(80)}\n${contentOrUrl}\n\n\n${"-".repeat(80)}\n`;
}
export function calculateFileTokensFromContent(path, item, shouldAddLineNumbers) {
    const contentOrUrl = item.type === "content"
        ? addLineNumbers(item.content || "", shouldAddLineNumbers)
        : item.type === "binary"
            ? item.url
            : "";
    const fileString = `${path}:\n${"-".repeat(80)}\n${contentOrUrl}\n\n\n${"-".repeat(80)}\n`;
    return Math.round(fileString.length / CHARACTERS_PER_TOKEN);
}
export function filePathToTokenTree(flatObject, shouldAddLineNumbers) {
    const result = {};
    for (const [path, value] of Object.entries(flatObject)) {
        let parts = path.split("/");
        parts = parts[0] === "" ? parts.slice(1) : parts;
        let current = result;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                // Leaf node: store token count
                current[part] = calculateFileTokensFromContent(path, value, shouldAddLineNumbers);
            }
            else {
                current[part] = current[part] || {};
                current = current[part];
            }
        }
    }
    return result;
}
export function formatRepoContent(files, options) {
    const { shouldAddLineNumbers, shouldOmitFiles } = options;
    const tree = filePathToNestedObject({ ...files }, () => null);
    const rawTokenTree = filePathToTokenTree(files, shouldAddLineNumbers);
    const tokenTree = processTokenTree(rawTokenTree);
    const treeString = tokenTreeToString(tokenTree);
    const treeTokens = Math.round(treeString.length / CHARACTERS_PER_TOKEN);
    const filePart = shouldOmitFiles
        ? ""
        : Object.keys(files)
            .map((path) => stringifyFileContent(path, files[path], shouldAddLineNumbers))
            .join("");
    const fileString = treeString + (shouldOmitFiles ? "" : "\n\n" + filePart);
    const tokens = Math.round((treeString + "\n\n" + filePart).length / CHARACTERS_PER_TOKEN);
    return { tree, tokenTree, fileString, tokens, treeTokens };
}
