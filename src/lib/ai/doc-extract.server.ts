/**
 * Server-side plain-text extraction for the document types no AI provider
 * accepts natively: DOCX, XLSX, CSV, TSV, TXT, Markdown and JSON.
 *
 * Images and PDFs do not come through here — those go straight to the model,
 * which reads them better than any extractor would (see media-analysis.server).
 * Everything else has to be turned into text locally first, because there is no
 * provider API that takes a .docx.
 *
 * No new dependency. DOCX and XLSX are ZIP archives of XML, and the runtime
 * already provides `DecompressionStream("deflate-raw")`, so a small central-
 * directory reader is all that is missing. (`mammoth` is in the tree but is
 * wired up for the browser-side KB uploader, where it reads a `File`; pulling
 * it into the Worker path would add a bundle and a runtime unknown to extract
 * text this file gets from one XML element.)
 *
 * The format is decided by SNIFFING THE BYTES, not by the stored MIME type.
 * WhatsApp, Gmail and half the world's mail clients label a .docx
 * "application/msword" and a .csv "application/vnd.ms-excel", so trusting the
 * label means mis-routing real files; the magic number never lies.
 */

/** Longest text we will hand to the model from one document. */
const MAX_TEXT_CHARS = 24_000;

/** Rows of a spreadsheet to keep. Beyond this it is a database, not a message. */
const MAX_SHEET_ROWS = 300;

const DEC = new TextDecoder("utf-8", { fatal: false });

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/* -------------------------------------------------------------------------- */
/*  Minimal ZIP reader                                                        */
/* -------------------------------------------------------------------------- */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/**
 * Lists the archive's entries from its central directory.
 *
 * The central directory is read rather than the local headers because a local
 * header is allowed to carry zeroed sizes and defer them to a trailing data
 * descriptor; the central directory always has the real values.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End-of-central-directory record, scanning back from the end. Its comment
  // field can be up to 64 KiB, which bounds the search.
  const maxBack = Math.min(bytes.length, 0xffff + 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= bytes.length - maxBack; i--) {
    if (i < 0) break;
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  // Zip64 marks its real values in an extra record we do not parse. A document
  // inside the 5 MB attachment cap is never zip64, so bail rather than guess.
  if (cdOffset === 0xffffffff || count === 0xffff) return null;

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length) return null;
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = DEC.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflates (or copies) one entry's bytes. */
async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lo = entry.localOffset;
  if (lo + 30 > bytes.length) return null;
  if (view.getUint32(lo, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(lo + 26, true);
  const extraLen = view.getUint16(lo + 28, true);
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  const data = bytes.subarray(start, end);

  if (entry.method === 0) return data; // stored
  if (entry.method !== 8) return null; // only deflate is worth supporting
  try {
    // "deflate-raw" is the headerless form ZIP uses; plain "deflate" expects a
    // zlib header and would fail on every entry.
    const stream = new Blob([data as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Reads one named entry as text, or null if it is absent or unreadable. */
async function entryText(
  bytes: Uint8Array,
  entries: ZipEntry[],
  name: string,
): Promise<string | null> {
  const e = entries.find((x) => x.name === name);
  if (!e) return null;
  const raw = await readEntry(bytes, e);
  return raw ? DEC.decode(raw) : null;
}

/* -------------------------------------------------------------------------- */
/*  XML helpers                                                               */
/* -------------------------------------------------------------------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, or "&amp;lt;" would decode twice into "<".
    .replace(/&amp;/g, "&");
}

/** All text inside `<tag>` elements, in document order. */
function collectTagText(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(decodeEntities(m[1]));
  return out;
}

/* -------------------------------------------------------------------------- */
/*  DOCX                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Word text lives in `<w:t>` elements grouped into `<w:p>` paragraphs. Taking
 * paragraphs one at a time is what keeps the output readable: collecting every
 * `<w:t>` in the file at once runs the whole document into a single line,
 * because Word splits a sentence across runs whenever formatting changes.
 */
function docxText(documentXml: string): string {
  const paras: string[] = [];
  // Self-closing <w:p/> is an empty paragraph — Word's blank line — and has to
  // be matched separately or the spacing silently disappears.
  for (const m of documentXml.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    if (m[1] === undefined) {
      paras.push("");
      continue;
    }
    // One ordered pass over the runs. Replacing <w:tab/> and <w:br/> first and
    // then collecting <w:t> elements does not work: the substituted characters
    // sit OUTSIDE any <w:t>, so collecting the elements throws them away and
    // "Line1<br/>Line2<tab/>Tabbed" comes out as "Line1Line2Tabbed".
    let text = "";
    const runs = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
    for (const r of m[1].matchAll(runs)) {
      if (r[1] !== undefined) text += decodeEntities(r[1]);
      else if (r[0].startsWith("<w:tab")) text += "\t";
      else text += "\n";
    }
    paras.push(text);
  }
  // Blank paragraphs are spacing in Word; collapse runs of them to one break.
  return paras
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* -------------------------------------------------------------------------- */
/*  XLSX                                                                      */
/* -------------------------------------------------------------------------- */

/** The shared-string table every text cell in a sheet points into by index. */
function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // A rich-text cell is several <t> runs inside one <si>; they concatenate.
    out.push(collectTagText(m[1], "t").join(""));
  }
  return out;
}

function sheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_SHEET_ROWS) break;
    const cells: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const inner = cm[2];
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value = "";
      if (t === "s") {
        // Shared string: <v> holds the index, not the text.
        const idx = Number(collectTagText(inner, "v")[0] ?? "");
        value = Number.isInteger(idx) ? (shared[idx] ?? "") : "";
      } else if (t === "inlineStr") {
        value = collectTagText(inner, "t").join("");
      } else {
        value = collectTagText(inner, "v")[0] ?? "";
      }
      cells.push(value.trim());
    }
    // An all-empty row is spacing; keeping it wastes prompt tokens.
    if (cells.some(Boolean)) rows.push(cells.join(" | "));
  }
  return rows;
}

async function xlsxText(bytes: Uint8Array, entries: ZipEntry[]): Promise<string> {
  const shared = sharedStrings(await entryText(bytes, entries, "xl/sharedStrings.xml"));
  const sheetNames = entries
    .map((e) => e.name)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const n = (s: string) => Number(/(\d+)/.exec(s)?.[1] ?? 0);
      return n(a) - n(b);
    });

  const parts: string[] = [];
  for (const name of sheetNames) {
    const xml = await entryText(bytes, entries, name);
    if (!xml) continue;
    const rows = sheetRows(xml, shared);
    if (!rows.length) continue;
    const label = sheetNames.length > 1 ? `Sheet ${/(\d+)/.exec(name)?.[1] ?? "?"}:\n` : "";
    parts.push(label + rows.join("\n"));
    if (parts.join("\n\n").length > MAX_TEXT_CHARS) break;
  }
  return parts.join("\n\n").trim();
}

/* -------------------------------------------------------------------------- */
/*  Delimited and plain text                                                  */
/* -------------------------------------------------------------------------- */

/**
 * True when the decoded text looks like a binary file that happened to decode.
 * A NUL byte does not occur in real UTF-8 text, and U+FFFD means the decoder
 * gave up on a byte; either in quantity means this is not a text document.
 */
function looksBinary(text: string): boolean {
  if (!text) return true;
  const bad = (text.match(/[\u0000�]/g) || []).length;
  return bad / text.length > 0.01;
}

/** Splits one delimited line, honouring doubled quotes inside quoted cells. */
function splitDelimited(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * Renders a CSV/TSV as aligned rows rather than raw commas, so the model can
 * tell which value belongs to which column. The delimiter is guessed from the
 * header, because ".csv" from a European locale is routinely semicolon-split.
 */
function delimitedText(raw: string): string {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return "";
  const head = lines[0];
  const counts: Array<[string, number]> = [
    ["\t", (head.match(/\t/g) || []).length],
    [",", (head.match(/,/g) || []).length],
    [";", (head.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ",";
  return lines
    .slice(0, MAX_SHEET_ROWS)
    .map((l) => splitDelimited(l, delim).join(" | "))
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

export type ExtractedKind = "docx" | "xlsx" | "delimited" | "text";

export interface ExtractedDocument {
  kind: ExtractedKind;
  text: string;
}

/**
 * Extracts readable text from a document's bytes, or null when the format is
 * one we cannot read (legacy .doc/.xls, an encrypted archive, a binary blob).
 *
 * Never throws: a document that cannot be read has to degrade to its
 * "[document]" label, not fail the agent's reply.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  filename: string | null,
): Promise<ExtractedDocument | null> {
  try {
    // PDFs are handled natively by the model; they must not reach here.
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return null;
    // Legacy OLE2 container: .doc, .xls, .ppt. Decoding it means implementing
    // a 1990s compound-file format, and both are rare enough to label instead.
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return null;

    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
      const entries = readCentralDirectory(bytes);
      if (!entries) return null;
      const docXml = await entryText(bytes, entries, "word/document.xml");
      if (docXml) {
        const text = docxText(docXml);
        return text ? { kind: "docx", text: text.slice(0, MAX_TEXT_CHARS) } : null;
      }
      if (entries.some((e) => e.name === "xl/workbook.xml")) {
        const text = await xlsxText(bytes, entries);
        return text ? { kind: "xlsx", text: text.slice(0, MAX_TEXT_CHARS) } : null;
      }
      // Some other zip — an .odt, a .pptx, an actual archive. Not read.
      return null;
    }

    const raw = DEC.decode(bytes);
    if (looksBinary(raw)) return null;

    const name = (filename ?? "").toLowerCase();
    const delimited =
      /\.(csv|tsv|tab)$/.test(name) ||
      // An unnamed file whose first line is clearly delimited is still a table.
      /^[^\n]{0,400}[,;\t][^\n]*\n/.test(raw);
    const text = delimited ? delimitedText(raw) : raw.trim();
    return text ? { kind: delimited ? "delimited" : "text", text: text.slice(0, MAX_TEXT_CHARS) } : null;
  } catch {
    return null;
  }
}
