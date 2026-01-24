import { type StreamingParseContext } from "./parse-zip";
import { type ContentType, type FormatOptions, type NestedObject, type ParseOptions, type TokenTree, type UithubResult, CHARACTERS_PER_TOKEN } from "./types";
export { type ContentType, type FormatOptions, type NestedObject, type ParseOptions, type TokenTree, type UithubResult, type StreamingParseContext, CHARACTERS_PER_TOKEN, };
export { addLineNumbers, calculateFileTokens, parseZipStreaming } from "./parse-zip";
export { filePathToNestedObject, filePathToTokenTree, formatRepoContent, tokenTreeToString, } from "./format";
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
export declare function parseGitHubZip(zipStream: ReadableStream<Uint8Array>, owner: string, repo: string, branch?: string, options?: UithubOptions): Promise<UithubResult>;
