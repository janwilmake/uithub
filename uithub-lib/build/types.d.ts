export declare const CHARACTERS_PER_TOKEN = 5;
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
    includeExt?: string[];
    excludeExt?: string[];
    includeDir?: string[];
    excludeDir?: string[];
    matchFilenames?: string[];
    paths?: string[];
    disableGenignore?: boolean;
    maxFileSize?: number;
    maxTokens: number;
    yamlFilter?: string;
    shouldAddLineNumbers?: boolean;
}
export interface FormatOptions {
    shouldAddLineNumbers: boolean;
    shouldOmitFiles: boolean;
    shouldOmitTree: boolean;
}
export interface UithubResult {
    files: {
        [path: string]: ContentType;
    };
    tree: NestedObject<null>;
    tokenTree: TokenTree;
    fileString: string;
    tokens: number;
    totalTokens: number;
    totalLines: number;
}
export interface ParsedZipResult {
    status: number;
    result?: {
        [path: string]: ContentType;
    };
    allPaths?: string[];
    shaOrBranch?: string;
    message?: string;
    totalTokens: number;
    totalLines: number;
    usedTokens: number;
}
