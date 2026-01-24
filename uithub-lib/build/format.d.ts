import { type ContentType, type FormatOptions, type NestedObject, type TokenTree } from "./types";
export declare function filePathToNestedObject<T, U>(flatObject: {
    [filepath: string]: T;
}, mapper: (value: T) => U): NestedObject<U>;
export declare function nestedObjectToTreeString<T>(obj: NestedObject<T>, prefix?: string, isLast?: boolean): string;
export declare function calculateFolderTokens(tree: TokenTree): number;
export declare function processTokenTree(tree: TokenTree): TokenTree;
export declare function tokenTreeToString(obj: TokenTree, prefix?: string, isLast?: boolean): string;
export declare function stringifyFileContent(path: string, item: ContentType, shouldAddLineNumbers: boolean): string;
export declare function calculateFileTokensFromContent(path: string, item: ContentType, shouldAddLineNumbers: boolean): number;
export declare function filePathToTokenTree(flatObject: {
    [filepath: string]: ContentType;
}, shouldAddLineNumbers: boolean): TokenTree;
export interface FormattedOutput {
    tree: NestedObject<null>;
    tokenTree: TokenTree;
    fileString: string;
    tokens: number;
    treeTokens: number;
}
export declare function formatRepoContent(files: {
    [path: string]: ContentType;
}, options: FormatOptions): FormattedOutput;
