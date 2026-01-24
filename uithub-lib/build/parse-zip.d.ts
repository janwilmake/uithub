import { type ParseOptions, type ParsedZipResult } from "./types";
export declare const DEFAULT_GENIGNORE = "package-lock.json\nbuild\nnode_modules\n";
export declare function addLineNumbers(content: string, shouldAddLineNumbers: boolean): string;
export declare function calculateFileTokens(path: string, content: string, shouldAddLineNumbers: boolean): number;
export interface StreamingParseContext extends ParseOptions {
    owner: string;
    repo: string;
    branch?: string;
}
export declare function parseZipStreaming(stream: ReadableStream<Uint8Array>, context: StreamingParseContext): Promise<ParsedZipResult>;
