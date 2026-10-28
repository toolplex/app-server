/*
 * Text from Word and PowerPoint files, read straight out of the OOXML zip.
 *
 * Both formats are zips of XML. A .docx keeps its body in word/document.xml
 * (paragraphs <w:p>, runs of text <w:t>, tabs, breaks); a .pptx keeps one
 * ppt/slides/slideN.xml per slide with text in <a:t>. Walking the XML with a
 * few patterns gives the reading text without a parser dependency, and the
 * result has the same shape as a PDF's extracted text, so the agent reads a
 * Word file page by page and a deck slide by slide through one tool.
 *
 * Layout, styling and images are not represented here — this is what the
 * document says, for reading and quoting. The original bytes stay on disk.
 */
import JSZip from "jszip";
import { buildTextResult, type TextExtractionResult } from "./textExtract.js";

export const OFFICE_TEXT_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

// The largest XML part we will inflate; a document body past this is not a
// document anyone reads, and inflating it would take the box's memory.
const MAX_XML_BYTES = 50 * 1024 * 1024;

export async function extractOfficeText(buffer: Buffer, mimeType: string): Promise<TextExtractionResult | null> {
  if (!OFFICE_TEXT_MIME_TYPES.has(mimeType)) return null;
  const zip = await JSZip.loadAsync(buffer);
  const pages = mimeType.includes("wordprocessingml") ? await docxPages(zip) : await pptxSlides(zip);
  const kept = pages.map((p) => p.trim()).filter((p) => p.length > 0);
  if (kept.length === 0) return null;
  return buildTextResult(kept, false);
}

/** Paragraph text of the body, split into pages at explicit page breaks. */
async function docxPages(zip: JSZip): Promise<string[]> {
  let xml = await partXml(zip, "word/document.xml");
  if (!xml) return [];
  // Word writes drawings twice (mc:Choice and a Fallback for old readers);
  // keep one. A text box nests whole paragraphs inside a paragraph, which a
  // flat paragraph split would cut in half — lift each box out, mark its
  // place, and splice its paragraphs back in where it sat.
  xml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  const boxes: string[] = [];
  xml = xml.replace(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g, (_, inner: string) => {
    boxes.push(paragraphs(inner).join("\n"));
    return `<w:t>[[TXBX${boxes.length - 1}]]</w:t>`;
  });
  const pages: string[] = [];
  let current: string[] = [];
  for (const para of paragraphsXml(xml)) {
    if (/<w:br\b[^>]*w:type="page"/.test(para) || /<w:lastRenderedPageBreak\b/.test(para)) {
      if (current.length > 0) pages.push(current.join("\n"));
      current = [];
    }
    current.push(runsText(para).replace(/\[\[TXBX(\d+)\]\]/g, (_, i: string) => `\n${boxes[Number(i)] ?? ""}\n`));
  }
  if (current.length > 0) pages.push(current.join("\n"));
  return pages;
}

function paragraphsXml(xml: string): string[] {
  return xml.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
}

/** Text of each <w:p> in a fragment, in order. */
function paragraphs(xml: string): string[] {
  return paragraphsXml(xml).map((p) => runsText(p));
}

/** One XML part as a string, or null when absent or too large to inflate. */
async function partXml(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof size === "number" && size > MAX_XML_BYTES) return null;
  return entry.async("string");
}

/** One page per slide, in slide order, titled "Slide N". */
async function pptxSlides(zip: JSZip): Promise<string[]> {
  const slideFiles = Object.keys(zip.files)
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  const pages: string[] = [];
  for (const { name, n } of slideFiles) {
    const xml = await partXml(zip, name);
    if (!xml) continue;
    const lines = (xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => runsText(p))
      .filter((t) => t.trim().length > 0);
    pages.push([`Slide ${n}`, ...lines].join("\n"));
  }
  return pages;
}

/** Visible text of one paragraph: text runs in order, tabs and line breaks kept; a table cell ends with a tab. */
function runsText(paragraphXml: string): string {
  let out = "";
  const tokens =
    paragraphXml.match(/<(?:w|a):t(?:\s[^>]*)?>[\s\S]*?<\/(?:w|a):t>|<(?:w|a):t\/>|<w:tab\/>|<w:br\/>|<a:br\/>|<\/w:tc>/g) ?? [];
  for (const tok of tokens) {
    if (tok === "<w:tab/>" || tok === "</w:tc>") out += "\t";
    else if (tok === "<w:br/>" || tok === "<a:br/>") out += "\n";
    else out += decodeXml(tok.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>$/, ""));
  }
  return out.replace(/\t+$/, "");
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
