export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16le-bom' | 'utf16be' | 'utf16be-bom' | 'utf32le-bom' | 'utf32be-bom' | 'gbk' | 'gb18030';
export interface DecodedText {
    content: string;
    encoding: TextEncoding;
}
/**
 * Line-ending style a save must round-trip. Only CRLF is recognized: a lone
 * `\r` (classic Mac) is neither counted by {@link detectEol} nor rewritten by
 * {@link restoreEol}, which mirrors the host filesystem backend
 * (`@deepseek-ai/dsh-fs-local`). Its `edit` tool is the reference behaviour
 * here — it restores the style detected at read time instead of normalizing the
 * file, so a model edit does not rewrite every line. The host's `write` tool
 * does NOT do this (it writes the model's LF text verbatim), which is why the
 * editor's own save has to carry the guarantee itself.
 */
export type TextEol = 'lf' | 'crlf';
/** The on-disk format of a file: how its bytes are encoded and how its lines
 *  end. Both are re-detected from disk before every save. */
export interface FileFormat {
    encoding: TextEncoding;
    eol: TextEol;
}
/**
 * Decode a text buffer, or `null` when it looks binary (NUL-bearing and not
 * UTF-16/32). `truncated` says the buffer is a prefix of a larger file, which
 * lets a read cap cut mid-character without flipping the detected encoding.
 */
export declare function decodeTextBytes(bytes: Buffer, truncated?: boolean): DecodedText | null;
export declare function encodeText(text: string, encoding: TextEncoding): Buffer;
/**
 * Majority vote over the leading {@link EOL_SNIFF_LIMIT} characters: CRLF wins
 * only when the CRLF pairs outnumber the bare LFs. A file with a single trailing
 * CRLF among many LF lines therefore reads as LF, and a `\r`-only (classic Mac)
 * file reads as LF without its bytes being touched — both the same verdict the
 * host backend reaches, so a plugin save and a model `edit` agree.
 */
export declare function detectEol(text: string): TextEol;
/**
 * Convert the editor's LF document back to the file's own style before
 * encoding. CRLF content is normalized first (unlike a naive `split('\n').join`
 * this can never turn an existing pair into `\r\r\n`) — the same guard the host
 * backend's `restoreLineEndings` documents. Everything else, including a lone
 * `\r`, is passed through untouched.
 */
export declare function restoreEol(text: string, eol: TextEol): string;
/**
 * Detect the on-disk format a save has to round-trip: byte encoding AND line
 * endings, from one sniff read. Called before the temp write on every save, so
 * the editor never silently converts GBK / UTF-16 / BOM'd UTF-8 bytes — nor a
 * CRLF file to LF, which for a one-line edit would land as a whole-file diff
 * (#871). A missing file yields UTF-8 + LF (see the comment below).
 */
export declare function fileFormatOf(path: string): Promise<FileFormat>;
