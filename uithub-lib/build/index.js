import { parseZipStreaming, } from "./parse-zip";
import { formatRepoContent } from "./format";
import { CHARACTERS_PER_TOKEN, } from "./types";
// Re-export types
export { CHARACTERS_PER_TOKEN, };
// Re-export utilities that might be useful
export { addLineNumbers, calculateFileTokens, parseZipStreaming } from "./parse-zip";
export { filePathToNestedObject, filePathToTokenTree, formatRepoContent, tokenTreeToString, } from "./format";
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
export async function parseGitHubZip(zipStream, owner, repo, branch, options = { maxTokens: 50000 }) {
    const parseContext = {
        owner,
        repo,
        branch,
        excludeDir: options.excludeDir,
        excludeExt: options.excludeExt,
        includeDir: options.includeDir,
        includeExt: options.includeExt,
        yamlFilter: options.yamlFilter,
        matchFilenames: options.matchFilenames,
        paths: options.paths,
        disableGenignore: options.disableGenignore,
        maxFileSize: options.maxFileSize,
        maxTokens: options.maxTokens,
        shouldAddLineNumbers: options.shouldAddLineNumbers ?? true,
    };
    const parseResult = await parseZipStreaming(zipStream, parseContext);
    if (!parseResult.result) {
        throw new Error(parseResult.message || "Failed to parse zip");
    }
    const formatOptions = {
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
