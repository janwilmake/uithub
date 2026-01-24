import { parse as parseYaml } from "yaml";
import { CHARACTERS_PER_TOKEN, } from "./types";
// ==================== CONSTANTS ====================
export const DEFAULT_GENIGNORE = `package-lock.json
build
node_modules
`;
// ZIP signatures
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIR_HEADER = 0x02014b50;
// ==================== GITIGNORE PARSER ====================
function escapeRegex(pattern) {
    return pattern.replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, "\\$&");
}
function prepareRegexPattern(pattern) {
    return escapeRegex(pattern).replace("**", "(.+)").replace("*", "([^\\/]+)");
}
function createRegExp(patterns) {
    return patterns.length > 0
        ? new RegExp(`^((${patterns.join(")|(")}))`)
        : new RegExp("$^");
}
function parseGitignore(content) {
    const lists = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line[0] !== "#")
        .reduce((lists, line) => {
        const isNegative = line[0] === "!";
        if (isNegative)
            line = line.slice(1);
        if (line[0] === "/")
            line = line.slice(1);
        lists[isNegative ? 1 : 0].push(line);
        return lists;
    }, [[], []]);
    return {
        positives: createRegExp(lists[0].sort().map(prepareRegexPattern)),
        negatives: createRegExp(lists[1].sort().map(prepareRegexPattern)),
    };
}
function compileGitignore(content) {
    const { positives, negatives } = parseGitignore(content);
    const checkInput = (input) => input[0] === "/" ? input.slice(1) : input;
    return {
        accepts: (input) => {
            input = checkInput(input);
            return negatives.test(input) || !positives.test(input);
        },
        denies: (input) => {
            input = checkInput(input);
            return !(negatives.test(input) || !positives.test(input));
        },
    };
}
// ==================== FILE FILTERING ====================
function shouldIncludeFile(context) {
    const { excludeDir, excludeExt, filePath, includeDir, includeExt, paths, yamlParse, matchFilenames, } = context;
    const ext = filePath.split(".").pop();
    const lowercaseFilename = filePath.split("/").pop().toLowerCase();
    if (matchFilenames &&
        !matchFilenames.find((name) => name.toLowerCase() === lowercaseFilename)) {
        return false;
    }
    if (includeExt && !includeExt.includes(ext))
        return false;
    if (excludeExt && excludeExt.includes(ext))
        return false;
    const pathAllowed = paths && paths.length > 0
        ? paths.some((path) => filePath.startsWith(path))
        : true;
    if (yamlParse) {
        const isInYamlFilter = filePath
            .split("/")
            .reduce((yaml, chunk) => yaml?.[chunk], yamlParse);
        return isInYamlFilter === null && pathAllowed;
    }
    else if (!pathAllowed) {
        return false;
    }
    if (includeDir && !includeDir.some((d) => filePath.slice(1).startsWith(d)))
        return false;
    if (excludeDir && excludeDir.some((d) => filePath.slice(1).startsWith(d)))
        return false;
    return true;
}
function isValidUtf8(data) {
    try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        decoder.decode(data);
        return true;
    }
    catch {
        return false;
    }
}
async function calculateHash(data) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
// ==================== LINE NUMBERS ====================
export function addLineNumbers(content, shouldAddLineNumbers) {
    if (!shouldAddLineNumbers)
        return content;
    const lines = content.split("\n");
    const totalLines = lines.length;
    const totalCharacters = String(totalLines).length;
    return lines
        .map((line, index) => {
        const lineNum = index + 1;
        const spacesNeeded = totalCharacters - String(lineNum).length;
        return " ".repeat(spacesNeeded) + String(lineNum) + " | " + line;
    })
        .join("\n");
}
export function calculateFileTokens(path, content, shouldAddLineNumbers) {
    const processed = addLineNumbers(content, shouldAddLineNumbers);
    const fileString = `${path}:\n${"-".repeat(80)}\n${processed}\n\n\n${"-".repeat(80)}\n`;
    return Math.ceil(fileString.length / CHARACTERS_PER_TOKEN);
}
function calculateFileLines(content) {
    return content.split("\n").length;
}
// ==================== STREAMING ZIP PARSER ====================
class StreamingZipReader {
    buffer = new Uint8Array(0);
    reader;
    done = false;
    constructor(stream) {
        this.reader = stream.getReader();
    }
    async ensureBytes(needed) {
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
    consume(bytes) {
        const result = this.buffer.slice(0, bytes);
        this.buffer = this.buffer.slice(bytes);
        return result;
    }
    readUint16(offset = 0) {
        return this.buffer[offset] | (this.buffer[offset + 1] << 8);
    }
    readUint32(offset = 0) {
        return (this.buffer[offset] |
            (this.buffer[offset + 1] << 8) |
            (this.buffer[offset + 2] << 16) |
            (this.buffer[offset + 3] << 24));
    }
    async *entries() {
        while (true) {
            if (!(await this.ensureBytes(4)))
                break;
            const signature = this.readUint32(0);
            if (signature === CENTRAL_DIR_HEADER || signature !== LOCAL_FILE_HEADER) {
                break;
            }
            if (!(await this.ensureBytes(30)))
                break;
            const compressionMethod = this.readUint16(8);
            const compressedSize = this.readUint32(18);
            const fileNameLength = this.readUint16(26);
            const extraFieldLength = this.readUint16(28);
            if (!(await this.ensureBytes(30 + fileNameLength)))
                break;
            const fileName = new TextDecoder().decode(this.buffer.slice(30, 30 + fileNameLength));
            const headerSize = 30 + fileNameLength + extraFieldLength;
            if (!(await this.ensureBytes(headerSize)))
                break;
            this.consume(headerSize);
            const generalPurposeFlag = this.buffer.length >= 6 ? this.readUint16(6 - headerSize) : 0;
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
                getData: async () => {
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
                            }
                            else {
                                await this.ensureBytes(12);
                                this.consume(12);
                            }
                        }
                    }
                    if (compressionMethod === 0) {
                        return compressedData;
                    }
                    else if (compressionMethod === 8) {
                        try {
                            return await inflateRaw(compressedData);
                        }
                        catch {
                            return null;
                        }
                    }
                    return null;
                },
            };
        }
    }
    async cancel() {
        try {
            await this.reader.cancel();
        }
        catch {
            // Ignore cancellation errors
        }
    }
}
async function inflateRaw(compressedData) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(compressedData);
    writer.close();
    const chunks = [];
    let totalLength = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
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
export async function parseZipStreaming(stream, context) {
    const { owner, repo, branch, excludeExt, includeExt, paths, includeDir, excludeDir, disableGenignore, maxFileSize, yamlFilter, matchFilenames, maxTokens, shouldAddLineNumbers = true, } = context;
    let yamlParse;
    try {
        if (yamlFilter) {
            yamlParse = parseYaml(yamlFilter);
        }
    }
    catch (e) {
        return {
            status: 500,
            message: "Couldn't parse yaml filter. Please ensure to provide valid url-encoded YAML. " +
                e.message,
            totalTokens: 0,
            totalLines: 0,
            usedTokens: 0,
        };
    }
    const shaOrBranch = branch || "HEAD";
    const zipReader = new StreamingZipReader(stream);
    const allFiles = new Map();
    const allPaths = [];
    let genignoreContent = DEFAULT_GENIGNORE;
    try {
        for await (const entry of zipReader.entries()) {
            if (entry.fileName.endsWith("/"))
                continue;
            const filePath = entry.fileName.split("/").slice(1).join("/");
            if (!filePath)
                continue;
            allPaths.push(filePath);
            if (filePath === ".genignore" && !disableGenignore) {
                const data = await entry.getData();
                if (data && isValidUtf8(data)) {
                    genignoreContent = new TextDecoder("utf-8").decode(data);
                }
                continue;
            }
            if (!shouldIncludeFile({
                matchFilenames,
                filePath,
                yamlParse,
                includeExt,
                excludeExt,
                includeDir,
                excludeDir,
                paths,
            })) {
                await entry.getData();
                continue;
            }
            const data = await entry.getData();
            if (!data)
                continue;
            const isText = isValidUtf8(data);
            if (isText && maxFileSize && data.length > maxFileSize) {
                continue;
            }
            allFiles.set(filePath, { data, isText });
        }
    }
    catch (e) {
        // Stream might have ended early, continue with what we have
    }
    const genignore = genignoreContent && !disableGenignore
        ? compileGitignore(genignoreContent)
        : undefined;
    const processedFiles = [];
    let totalTokens = 0;
    let totalLines = 0;
    for (const [filePath, { data, isText }] of allFiles) {
        if (genignore && !genignore.accepts(filePath)) {
            continue;
        }
        const hash = await calculateHash(data);
        if (isText) {
            const content = new TextDecoder("utf-8").decode(data);
            const tokens = calculateFileTokens("/" + filePath, content, shouldAddLineNumbers);
            const lines = calculateFileLines(content);
            processedFiles.push({
                path: "/" + filePath,
                content: {
                    type: "content",
                    content,
                    hash,
                    size: data.length,
                    url: undefined,
                },
                tokens,
                lines,
            });
            totalTokens += tokens;
            totalLines += lines;
        }
        else {
            const tokens = Math.ceil((`/${filePath}:\n` +
                "-".repeat(80) +
                `\nhttps://raw.githubusercontent.com/${owner}/${repo}/${shaOrBranch}/${filePath}\n\n\n` +
                "-".repeat(80) +
                "\n").length / CHARACTERS_PER_TOKEN);
            processedFiles.push({
                path: "/" + filePath,
                content: {
                    type: "binary",
                    content: undefined,
                    hash,
                    size: data.length,
                    url: `https://raw.githubusercontent.com/${owner}/${repo}/${shaOrBranch}/${filePath}`,
                },
                tokens,
                lines: 1,
            });
            totalTokens += tokens;
            totalLines += 1;
        }
    }
    processedFiles.sort((a, b) => a.tokens - b.tokens);
    const result = {};
    let usedTokens = 0;
    for (const file of processedFiles) {
        if (usedTokens + file.tokens <= maxTokens) {
            result[file.path] = file.content;
            usedTokens += file.tokens;
        }
    }
    return {
        status: 200,
        result,
        allPaths,
        shaOrBranch,
        totalTokens,
        totalLines,
        usedTokens,
    };
}
