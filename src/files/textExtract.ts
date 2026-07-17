/**
 * Two-stage PDF text extraction.
 *
 * Stage 1: pdfjs-dist reads any text stream embedded in the PDF. Fast and
 * reliable for computer-generated PDFs (Tableau exports, Word/Excel PDFs,
 * anything printed to PDF from a text-rendering application). No system
 * dependency, pure JS.
 *
 * Stage 2: if Stage 1 yields little/no text, the PDF is likely image-based
 * (scanned document, phone photo of a document, legacy archive without an
 * OCR pass). We shell out to `ocrmypdf`, which pre-processes (deskew,
 * denoise), runs Tesseract, and writes a NEW PDF with a text layer added.
 * We then re-run Stage 1 on that OCR'd PDF and take the resulting text.
 *
 * OCRmyPDF is an optional system binary (`brew install ocrmypdf` on the
 * Burlington Mac, apt on Linux). If it's not installed, Stage 2 is skipped
 * and the caller falls back to serving the raw bytes to the agent. That
 * degrades cleanly — non-OCR orgs just don't get scanned-PDF support.
 *
 * Fields returned reflect the whole document AFTER extraction:
 * - `pages`: array of page-level text (index 0 = page 1)
 * - `wordCount` / `charCount`: totals across all pages
 * - `firstPagePreview`: first ~500 chars of page 1, for the manifest overview
 * - `ocrApplied`: true iff Stage 2 ran
 *
 * A `null` return means both stages failed — caller should keep the file as
 * kind:"raw" and rely on the raw-bytes read_attachment path.
 */

import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// pdfjs-dist v5 is ESM-only; the legacy build lives at the /legacy path for
// Node.js compatibility (no browser-specific globals). Using a dynamic import
// so this module loads lazily — only PDF ingests pay the ~15MB memory cost of
// bringing pdfjs into the process.
async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

export interface TextExtractionResult {
  pages: string[];
  wordCount: number;
  charCount: number;
  firstPagePreview: string;
  ocrApplied: boolean;
}

// If pdfjs returns fewer than this many "readable" chars per page on average,
// the PDF is treated as image-based and Stage 2 (OCR) is tried. 20 chars/page
// is well below anything a real text-based PDF produces (a single sentence is
// typically 50+ chars) and well above the noise pdfjs sometimes emits for
// pure-image pages (single-letter headers, page numbers, etc.).
const IMAGE_PDF_THRESHOLD_CHARS_PER_PAGE = 20;

// Ratio of alphanumeric characters to total non-whitespace characters. Real
// extracted text sits at 0.7+ (letters, digits, punctuation). Pure garbage
// from failed extraction often lands below 0.5 (control characters, PDF
// dictionary keys, mojibake). Below this, we try OCR.
const READABLE_RATIO_THRESHOLD = 0.5;

// Ceiling on OCRmyPDF wall-clock time. Big scanned docs (20+ pages) can push
// past this; better to give up and fall back to raw than to hold the ingest
// request open indefinitely.
const OCR_TIMEOUT_MS = 90_000;

// Track ocrmypdf availability with a one-shot probe: check `which ocrmypdf`
// on first use, cache the result for the process lifetime. Avoids spawning a
// probe process on every ingest.
let ocrAvailable: boolean | null = null;

async function isOcrAvailable(): Promise<boolean> {
  if (ocrAvailable !== null) return ocrAvailable;
  try {
    await execFileAsync("which", ["ocrmypdf"], { timeout: 2000 });
    ocrAvailable = true;
  } catch {
    ocrAvailable = false;
  }
  return ocrAvailable;
}

/**
 * Run Stage 1 (pdfjs-dist text stream extraction) on a PDF buffer. Returns
 * per-page text and totals. Never throws — errors return an empty result so
 * the caller can decide whether to try Stage 2 or give up.
 */
async function extractWithPdfjs(buffer: Buffer): Promise<{ pages: string[] } | null> {
  try {
    const pdfjs = await loadPdfjs();
    // pdfjs mutates its input buffer; hand it a fresh copy to keep the caller's
    // buffer intact.
    const data = new Uint8Array(buffer);
    const doc = await pdfjs.getDocument({
      data,
      // Suppress the noisy console warnings pdfjs emits about font metrics
      // for many real-world PDFs. They're benign.
      verbosity: 0,
    }).promise;
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      // Each `item` is a text run with its own baseline; join with a space
      // for word-level extraction. Preserving line breaks would require
      // tracking Y-coordinates, which we don't need for search/summarization.
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(pageText);
    }
    // Free the internal cache — matters when we're about to run OCR and
    // re-parse a second copy of the file.
    await doc.destroy();
    return { pages };
  } catch {
    return null;
  }
}

/**
 * Decide whether a Stage 1 result is good enough to skip OCR. Returns true if
 * the extracted text looks substantive (enough chars/page + a readable ratio
 * of alphanumeric content).
 */
function looksLikeRealText(pages: string[]): boolean {
  const totalChars = pages.reduce((sum, p) => sum + p.length, 0);
  if (pages.length === 0) return false;
  if (totalChars / pages.length < IMAGE_PDF_THRESHOLD_CHARS_PER_PAGE) return false;
  const nonWhite = pages.join("").replace(/\s/g, "");
  if (nonWhite.length === 0) return false;
  const readable = nonWhite.match(/[a-zA-Z0-9]/g)?.length ?? 0;
  return readable / nonWhite.length >= READABLE_RATIO_THRESHOLD;
}

/**
 * Stage 2: run ocrmypdf on the input PDF, producing a searchable PDF with an
 * added text layer. Returns the output buffer, or null if ocrmypdf isn't
 * installed, times out, or errors. Written to a temp path because ocrmypdf
 * needs a file input — we clean it up in `finally`.
 */
async function runOcr(inputPath: string, outputPath: string): Promise<Buffer | null> {
  if (!(await isOcrAvailable())) return null;
  try {
    await execFileAsync(
      "ocrmypdf",
      [
        // Force OCR even if a text layer already exists — we only reach this
        // path when Stage 1 failed, so any existing layer is noise.
        "--force-ocr",
        // Skip pages that OCRmyPDF's own text detector says already have
        // text. Defensive against edge cases where --force-ocr conflicts
        // with mixed-content PDFs.
        "--skip-text",
        // Deskew crooked scans (phone photos of docs, etc.). Small accuracy
        // win at negligible cost.
        "--deskew",
        // English only for now — Burlington's docs are all English. Adding
        // more languages inflates the Tesseract model download and slows OCR
        // per page. Configurable later if a client needs multilingual.
        "--language",
        "eng",
        // Quiet down ocrmypdf's stderr chatter. Only print real errors.
        "--quiet",
        inputPath,
        outputPath,
      ],
      { timeout: OCR_TIMEOUT_MS },
    );
    const { readFile } = await import("node:fs/promises");
    return await readFile(outputPath);
  } catch {
    return null;
  }
}

/**
 * Public entry point. Given a PDF buffer, try Stage 1; if it doesn't look
 * like real text, try Stage 2 (OCR + re-parse). Returns null iff both stages
 * fail — caller keeps the file as kind:"raw".
 *
 * `tempDir` is used to stage the input/output PDFs for Stage 2. Ideally the
 * same dir the raw bytes ended up in; we clean up after ourselves.
 * `fileId` is used to namespace those temp paths so parallel ingests don't
 * collide.
 */
export async function extractPdfText(
  buffer: Buffer,
  tempDir: string,
  fileId: string,
): Promise<TextExtractionResult | null> {
  // Stage 1
  const stage1 = await extractWithPdfjs(buffer);
  if (stage1 && looksLikeRealText(stage1.pages)) {
    return buildResult(stage1.pages, false);
  }

  // Stage 2: OCR fallback
  const inputPath = `${tempDir}/${fileId}.ocr-in.pdf`;
  const outputPath = `${tempDir}/${fileId}.ocr-out.pdf`;
  try {
    await writeFile(inputPath, buffer);
    const ocrPdf = await runOcr(inputPath, outputPath);
    if (!ocrPdf) return null;
    const stage2 = await extractWithPdfjs(ocrPdf);
    if (!stage2 || !looksLikeRealText(stage2.pages)) return null;
    return buildResult(stage2.pages, true);
  } finally {
    // Best-effort cleanup — worst case the TTL sweep gets these later.
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function buildResult(pages: string[], ocrApplied: boolean): TextExtractionResult {
  const joined = pages.join(" ");
  const wordCount = joined.split(/\s+/).filter(Boolean).length;
  const charCount = pages.reduce((sum, p) => sum + p.length, 0);
  const firstPagePreview = (pages[0] || "").slice(0, 500);
  return { pages, wordCount, charCount, firstPagePreview, ocrApplied };
}
