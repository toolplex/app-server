// ---------------------------------------------------------------------------
// The formulas of a workbook file, read from the file itself.
//
// A copy of somebody's workbook is made by loading it into a library and
// saving it again. What the library does not model, it changes or drops on
// the way through, without a word: a formula on a cell that is also a link
// is saved as its last value; a formula that spills is saved as a fixed
// block; a name that is a constant disappears. The library cannot be asked
// whether it did so, since what it reads back is its own idea of the file.
//
// So the two files are compared as files. Every formula of the original
// must be in the copy, at the same cell, saying the same thing, unless an op
// wrote that cell; and every name the original defines must still be defined
// the same way. A copy that fails this is not kept, and the caller is told
// what the copy could not carry.
//
// Reading is by scanning the sheet XML for <f> elements: no parser, nothing
// modelled, one sheet in memory at a time.
// ---------------------------------------------------------------------------

import JSZip from "jszip";

/** What one formula cell says, as text that is equal exactly when the formulas are. */
export type SheetFormulas = Map<string, string>;

export interface WorkbookFormulas {
  /** Sheet name → cell address → what the formula there says. */
  sheets: Map<string, SheetFormulas>;
  /** Defined names (not the ones Excel keeps for print areas and filters) → what each refers to. */
  names: Map<string, string>;
  /** What this file holds that a copy made here cannot carry at all. */
  cannotCarry: string[];
  formulas: number;
}

const decode = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

/** The formula cells of one sheet's XML. */
export function formulasInSheetXml(xml: string, sheet: string, cannotCarry: string[]): SheetFormulas {
  const out: SheetFormulas = new Map();
  if (/<[A-Za-z0-9]+:worksheet[\s>]/.test(xml)) {
    cannotCarry.push(`sheet "${sheet}" is written in a form of the file format this server does not read`);
    return out;
  }
  // The first cell of each filled-down formula, by the number the file gives the group.
  const firstOf = new Map<string, string>();
  const pointing: Array<{ address: string; si: string }> = [];
  let pos = 0;
  while ((pos = xml.indexOf("<f", pos)) !== -1) {
    const next = xml[pos + 2];
    if (next !== ">" && next !== " " && next !== "/") {
      pos += 2; // <font>, <formula1>, <filter>…
      continue;
    }
    const tagEnd = xml.indexOf(">", pos);
    if (tagEnd === -1) break;
    const selfClosed = xml[tagEnd - 1] === "/";
    const fTag = xml.slice(pos + 2, selfClosed ? tagEnd - 1 : tagEnd);
    let text = "";
    let after = tagEnd + 1;
    if (!selfClosed) {
      const close = xml.indexOf("</f>", tagEnd);
      if (close === -1) break;
      text = decode(xml.slice(tagEnd + 1, close));
      after = close + 4;
    }
    const cStart = xml.lastIndexOf("<c ", pos);
    const cEnd = cStart === -1 ? -1 : xml.indexOf(">", cStart);
    pos = after;
    // Not inside a cell (a conditional format, a validation): nothing a cell says.
    if (cStart === -1 || cEnd === -1 || cEnd > tagEnd || xml[cEnd - 1] === "/" || xml.lastIndexOf("</c>", tagEnd) > cStart) continue;
    const cTag = xml.slice(cStart + 2, cEnd);
    const address = attr(cTag, "r");
    if (!address) continue;
    const kind = attr(fTag, "t") ?? "normal";
    const ref = attr(fTag, "ref") ?? "";
    const si = attr(fTag, "si");
    // A formula whose result spills into the cells around it carries a mark on its cell.
    const spills = attr(cTag, "cm") !== undefined ? "|spills" : "";
    if (kind === "dataTable") {
      cannotCarry.push(`a what-if data table (${sheet}!${address})`);
      continue;
    }
    if (spills) cannotCarry.push(`a formula that spills into the cells around it (${sheet}!${address})`);
    if (kind === "shared" && si !== undefined) {
      if (ref !== "") {
        firstOf.set(si, address);
        out.set(address, `first of ${ref}: =${text}`);
      } else {
        pointing.push({ address, si });
      }
      continue;
    }
    out.set(address, kind === "array" ? `array over ${ref}: =${text}${spills}` : `=${text}${spills}`);
  }
  for (const p of pointing) out.set(p.address, `as ${firstOf.get(p.si) ?? "?"}`);
  return out;
}

/** Every formula and every defined name of an .xlsx file. */
export async function formulasInFile(file: Buffer): Promise<WorkbookFormulas> {
  const zip = await JSZip.loadAsync(file);
  const read = async (path: string): Promise<string> => (await zip.file(path)?.async("string")) ?? "";
  const cannotCarry: string[] = [];
  const workbook = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const to = attr(m[0], "Target");
    if (id && to) target.set(id, to.startsWith("/") ? to.slice(1) : `xl/${to}`);
  }
  const sheets = new Map<string, SheetFormulas>();
  let formulas = 0;
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = decode(attr(m[0], "name") ?? "");
    const path = target.get(attr(m[0], "r:id") ?? "") ?? "";
    // Chart sheets and the like hold no cells.
    if (!/worksheets\//.test(path)) continue;
    const xml = await read(path);
    const found = xml.includes("<f") ? formulasInSheetXml(xml, name, cannotCarry) : new Map<string, string>();
    sheets.set(name, found);
    formulas += found.size;
  }
  const names = new Map<string, string>();
  for (const m of workbook.matchAll(/<definedName\s([^>]*)>([^<]*)<\/definedName>/g)) {
    const name = decode(attr(m[1], "name") ?? "");
    if (/^_xlnm\./i.test(name)) continue; // print areas, print titles, filters: Excel's own
    // A name may belong to one sheet only. The copy keeps one name of each
    // spelling for the whole workbook, which is the same thing unless two
    // sheets each have their own.
    if (names.has(name)) cannotCarry.push(`the name "${name}", which more than one sheet defines for itself`);
    // A sheet name is written with or without quotes; the two mean the same.
    names.set(name, decode(m[2]).replace(/'([^'!]+)'!/g, "$1!"));
  }
  return { sheets, names, cannotCarry, formulas };
}

/**
 * How the copy's formulas differ from the original's, outside the cells that
 * were written on purpose: at most a handful, or nothing.
 *
 * `touched` are the cells an op wrote, by sheet. `released` are cells that
 * were given a formula of their own because the first cell of their
 * filled-down formula was written: they must still hold a formula.
 */
export function formulaDifferences(base: WorkbookFormulas, copy: WorkbookFormulas, touched: Map<string, Set<string>>, released: Map<string, Set<string>>): string[] {
  const wrong: string[] = [];
  const note = (s: string) => void (wrong.length < 6 && wrong.push(s));
  for (const [sheet, was] of base.sheets) {
    const is = copy.sheets.get(sheet);
    if (!is) {
      note(`sheet "${sheet}" is not in the copy`);
      continue;
    }
    const mine = touched.get(sheet) ?? new Set<string>();
    const freed = released.get(sheet) ?? new Set<string>();
    for (const address of new Set([...was.keys(), ...is.keys()])) {
      if (mine.has(address)) continue;
      const before = was.get(address);
      const after = is.get(address);
      if (freed.has(address)) {
        if (after === undefined || !after.startsWith("=")) note(`${sheet}!${address} was to keep its formula and holds ${after ?? "none"}`);
        continue;
      }
      if (before === after) continue;
      if (before !== undefined && after === undefined) note(`${sheet}!${address} holds a formula in the original (${before.slice(0, 80)}) and none in the copy`);
      else if (before === undefined) note(`${sheet}!${address} holds a formula in the copy (${String(after).slice(0, 80)}) that the original does not have`);
      else note(`the formula at ${sheet}!${address} reads "${before.slice(0, 80)}" in the original and "${String(after).slice(0, 80)}" in the copy`);
    }
  }
  for (const [name, refersTo] of base.names) {
    const now = copy.names.get(name);
    if (now === undefined) note(`the name "${name}" (${refersTo.slice(0, 60)}) is not in the copy`);
    else if (now !== refersTo) note(`the name "${name}" refers to "${refersTo.slice(0, 60)}" in the original and to "${now.slice(0, 60)}" in the copy`);
  }
  return wrong;
}
