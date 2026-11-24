// mend — one command that applies an AI model's edit to a tree of text files.
//
// Models write edits in four shapes: a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
// calls as JSON. This file reads any of the four, finds the lines each edit
// names, and writes every change or none. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Thrown by a patch reader: the patch is unreadable at this 1-based line. */
class PatchFault extends Error {
  readonly patchLine: number;
  constructor(patchLine: number) {
    super(`parse ${patchLine}`);
    this.patchLine = patchLine;
  }
}

/** One edit that did not go through: its code and the path it concerns. */
interface EditIssue {
  code: string;
  file: string;
}

/** A file's text, taken apart at its own line break. */
interface Doc {
  lines: string[];
  eol: string;
  trailing: boolean;
}

/** Split patch text into lines: split at \n, drop one trailing \r per line,
    and drop the empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Take a file's text apart. Its break is CRLF when its first line feed
    follows a carriage return, and LF otherwise. An empty file has no lines. */
function splitDocText(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', trailing: false };
  const lf = text.indexOf('\n');
  const eol = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  const body = trailing ? text.slice(0, text.length - eol.length) : text;
  return { lines: body.split(eol), eol, trailing };
}

/** Put a file's text back together from its lines. */
function joinDocText(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.trailing ? doc.eol : '');
}

/** A path is safe when it is not empty, does not start with /, holds no \,
    and none of its /-separated segments is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** The whitespace at the start of a line (spaces and tabs only). */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line reduced the way a matching tier compares it: tier 0 compares it
    whole, tier 1 without trailing spaces and tabs, tier 2 without leading
    or trailing spaces and tabs. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where `oldLines` occur in
    `lines` at this tier. Occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  const k = oldLines.length;
  const keys = oldLines.map((l) => tierKey(l, tier));
  for (let i = from; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (tierKey(lines[i + j], tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** One line of a hunk or chunk body: a context line, a removed line, an
    added line, or a backslash line (as in "\ No newline at end of file"). */
interface BodyItem {
  flavor: 'ctx' | 'del' | 'add' | 'mark';
  text: string;
}

/** The old and new lines a body stands for, and for each new line the index
    of the old line it is a context line of, or -1 when it is an added line. */
interface BodySplit {
  oldLines: string[];
  newLines: string[];
  ctxOf: number[];
}

function splitBodyItems(body: BodyItem[]): BodySplit {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctxOf: number[] = [];
  for (const item of body) {
    if (item.flavor === 'ctx') {
      ctxOf.push(oldLines.length);
      oldLines.push(item.text);
      newLines.push(item.text);
    } else if (item.flavor === 'del') {
      oldLines.push(item.text);
    } else if (item.flavor === 'add') {
      ctxOf.push(-1);
      newLines.push(item.text);
    }
  }
  return { oldLines, newLines, ctxOf };
}

/** The lines that replace a match at position `at` in the file. A context
    line is written as the file's own matched line, never the patch's. At
    tier 2 every other line is re-indented from the patch's base indent to
    the file's; at tiers 0 and 1 the lines are written as they are. */
function buildReplacement(fileLines: string[], at: number, tier: number, split: BodySplit): string[] {
  return split.newLines.map((line, j) => {
    const oi = split.ctxOf[j];
    if (oi >= 0) return fileLines[at + oi];
    if (tier !== 2) return line;
    if (line === '' || line.trim() === '') return line;
    const p = leadingWs(split.oldLines[0]);
    if (!line.startsWith(p)) return line;
    return leadingWs(fileLines[at]) + line.slice(p.length);
  });
}

/** True when a backslash line follows the body's last context or added
    line: the written file then ends without a line break. */
function bodyEndsBare(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].flavor === 'ctx' || body[i].flavor === 'add') {
      return i + 1 < body.length && body[i + 1].flavor === 'mark';
    }
  }
  return false;
}

/** Replace `oldLen` lines at `at` with `newLines`, keeping the file's own
    break and the given trailing-break state. */
function applyChange(doc: Doc, at: number, oldLen: number, newLines: string[], trailing: boolean): Doc {
  const lines = [...doc.lines.slice(0, at), ...newLines, ...doc.lines.slice(at + oldLen)];
  return { lines, eol: doc.eol, trailing };
}

/** The first tier at which `oldLines` occur, and the occurrence a unified
    hunk takes: the one nearest to `target`, the earlier of two equally near.
    Null when the lines occur at no tier. */
function locateUnified(lines: string[], oldLines: string[], target: number, strict: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, oldLines, tier, 0);
    if (occ.length === 0) continue;
    let best = occ[0];
    for (const o of occ) {
      if (Math.abs(o - target) < Math.abs(best - target)) best = o;
    }
    return { at: best, tier };
  }
  return null;
}

/** The single occurrence a SEARCH/REPLACE block needs: the first tier with
    one. 'many' when that tier holds more than one, null when none holds any. */
function locateUnique(lines: string[], oldLines: string[], strict: boolean): { at: number; tier: number } | 'many' | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, oldLines, tier, 0);
    if (occ.length === 0) continue;
    if (occ.length > 1) return 'many';
    return { at: occ[0], tier };
  }
  return null;
}

/** The first line at or after `cursor` equal to a V4A anchor, at the first
    tier where one is. Null when no tier has one. */
function locateAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = tierKey(anchor, tier);
    for (let i = cursor; i < lines.length; i++) {
      if (tierKey(lines[i], tier) === key) return i;
    }
  }
  return null;
}

/** The first occurrence of a V4A chunk's old lines at or after the cursor,
    at the first tier with one. An end-of-file chunk takes only an occurrence
    that ends at the file's last line. */
function locateV4a(lines: string[], oldLines: string[], cursor: number, strict: boolean, eof: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, oldLines, tier, cursor);
    const cand = eof ? occ.filter((o) => o + oldLines.length === lines.length) : occ;
    if (cand.length > 0) return { at: cand[0], tier };
  }
  return null;
}

/** One edit the patch asks for: every path it names, and the work it does
    on the tree. The work returns the failure, or null when it went through.
    It must leave the tree untouched when it fails. */
interface Edit {
  paths: string[];
  run: (tree: PatchTree, strict: boolean) => EditIssue | null;
}

/** The tree the patch works on: what each touched path held before the
    patch, and what it holds now. Files are read from disk the first time an
    edit touches them. */
class PatchTree {
  private before = new Map<string, string | null>();
  private after = new Map<string, string | null>();
  private moves: Array<{ from: string; to: string }> = [];

  /** The text a path holds now, or null when it holds no file. */
  text(p: string): string | null {
    if (!this.before.has(p)) {
      let content: string | null = null;
      try {
        if (fs.statSync(p).isFile()) content = fs.readFileSync(p, 'utf8');
      } catch {
        content = null;
      }
      this.before.set(p, content);
      this.after.set(p, content);
    }
    const v = this.after.get(p);
    return v === undefined ? null : v;
  }

  set(p: string, text: string): void {
    if (!this.before.has(p)) this.text(p);
    this.after.set(p, text);
  }

  del(p: string): void {
    if (!this.before.has(p)) this.text(p);
    this.after.set(p, null);
  }

  noteMove(from: string, to: string): void {
    this.moves.push({ from, to });
  }

  /** The output rows for the paths whose state changed, in byte order of
      the paths (a move's row sorts by its new path and replaces that pair's
      delete and add rows). */
  changeRows(): Array<{ key: string; line: string }> {
    const rows: Array<{ key: string; line: string }> = [];
    const covered = new Set<string>();
    for (const { from, to } of this.moves) {
      const bFrom = this.before.get(from) ?? null;
      const aFrom = this.after.get(from) ?? null;
      const bTo = this.before.get(to) ?? null;
      const aTo = this.after.get(to) ?? null;
      if (bFrom !== null && aFrom === null && bTo === null && aTo !== null) {
        rows.push({ key: to, line: `R ${from} -> ${to}` });
        covered.add(from);
        covered.add(to);
      }
    }
    const keys = new Set([...this.before.keys(), ...this.after.keys()]);
    for (const p of keys) {
      if (covered.has(p)) continue;
      const b = this.before.get(p) ?? null;
      const a = this.after.get(p) ?? null;
      if (b === a) continue;
      if (b === null) rows.push({ key: p, line: `A ${p}` });
      else if (a === null) rows.push({ key: p, line: `D ${p}` });
      else rows.push({ key: p, line: `M ${p}` });
    }
    rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
    return rows;
  }

  /** Write every change to disk: create or rewrite changed files, remove
      deleted ones. Directories are made as files need them. */
  writeAll(): void {
    for (const p of new Set([...this.before.keys(), ...this.after.keys()])) {
      const b = this.before.get(p) ?? null;
      const a = this.after.get(p) ?? null;
      if (b === a) continue;
      if (a === null) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* a path that cannot be removed is left as it is */
        }
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, a);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                     */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  a: number;
  body: BodyItem[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A path from a `--- ` or `+++ ` line: the text after the four characters,
    up to the first tab, with surrounding spaces removed and a leading a/ or
    b/ taken off. */
function diffHeaderPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** Read a unified diff's lines into its sections. */
function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let curHunk: UnifiedHunk | null = null;
  let inHeader = false;
  let headerOld: string | null = null;
  let headerNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;

  const freshSection = (): UnifiedSection => ({ oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] });

  const finishHunk = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const lastB = curHunk.body[curHunk.body.length - 1];
        if (lastB.flavor === 'ctx' && lastB.text === '') curHunk.body.pop();
        else break;
      }
      if (cur !== null) cur.hunks.push(curHunk);
      curHunk = null;
    }
  };

  const finishSection = (): void => {
    finishHunk();
    if (cur !== null) {
      const oldP = headerOld ?? renameFrom ?? diffOld;
      const newP = headerNew ?? renameTo ?? diffNew;
      cur.oldPath = oldP === '/dev/null' ? null : oldP;
      cur.newPath = newP === '/dev/null' ? null : newP;
      sections.push(cur);
    }
    cur = null;
    inHeader = false;
    headerOld = null;
    headerNew = null;
    renameFrom = null;
    renameTo = null;
    diffOld = null;
    diffNew = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new PatchFault(lineNo);
      finishSection();
      cur = freshSection();
      diffOld = m[1];
      diffNew = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new PatchFault(lineNo);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new PatchFault(lineNo);
      finishHunk();
      curHunk = { a: Number(m[1]), body: [] };
      inHeader = false;
      i++;
      continue;
    }
    if (curHunk !== null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        finishSection();
        cur = freshSection();
        headerOld = diffHeaderPath(line);
        headerNew = diffHeaderPath(lines[i + 1]);
        inHeader = true;
        i += 2;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        const flavor = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'del' : line[0] === '+' ? 'add' : 'mark';
        curHunk.body.push({ flavor, text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        cur = freshSection();
        headerOld = diffHeaderPath(line);
        headerNew = diffHeaderPath(lines[i + 1]);
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // In a section, not inside a hunk body. While the section is still in
    // its header, a ---/+++ pair names this section's paths; once hunks
    // have begun, the pair starts a new section instead.
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          headerOld = diffHeaderPath(line);
          headerNew = diffHeaderPath(lines[i + 1]);
          i += 2;
          continue;
        }
        throw new PatchFault(i + 2);
      }
      if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      finishSection();
      cur = freshSection();
      headerOld = diffHeaderPath(line);
      headerNew = diffHeaderPath(lines[i + 1]);
      inHeader = true;
      i += 2;
      continue;
    }
    i++;
  }
  finishSection();
  return sections.map(unifiedSectionToEdit);
}

/** Apply one section's hunks in order to a document. Each hunk works on
    the result of the ones before it. */
function applyUnifiedHunks(doc: Doc, hunks: UnifiedHunk[], strict: boolean): { ok: true; doc: Doc } | { ok: false } {
  let d = 0;
  for (const hunk of hunks) {
    const split = splitBodyItems(hunk.body);
    if (split.oldLines.length === 0) {
      const at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
      const trailing = at === doc.lines.length ? !bodyEndsBare(hunk.body) : doc.trailing;
      doc = applyChange(doc, at, 0, split.newLines, trailing);
    } else {
      const found = locateUnified(doc.lines, split.oldLines, hunk.a - 1 + d, strict);
      if (found === null) return { ok: false };
      const repl = buildReplacement(doc.lines, found.at, found.tier, split);
      const touchesEnd = found.at + split.oldLines.length === doc.lines.length;
      const trailing = touchesEnd ? !bodyEndsBare(hunk.body) : doc.trailing;
      doc = applyChange(doc, found.at, split.oldLines.length, repl, trailing);
    }
    d += split.newLines.length - split.oldLines.length;
  }
  return { ok: true, doc };
}

/** The text a created file holds: the `+` lines of all its hunks, in order,
    with LF breaks and a final break unless a backslash line follows the
    last `+` line. */
function creationText(hunks: UnifiedHunk[]): string {
  const plusLines: string[] = [];
  let lastBare = false;
  let sawPlus = false;
  for (const hunk of hunks) {
    for (let j = 0; j < hunk.body.length; j++) {
      if (hunk.body[j].flavor !== 'add') continue;
      plusLines.push(hunk.body[j].text);
      sawPlus = true;
      lastBare = j + 1 < hunk.body.length && hunk.body[j + 1].flavor === 'mark';
    }
  }
  if (!sawPlus) return '';
  return plusLines.join('\n') + (lastBare ? '' : '\n');
}

/** One unified section as the edit it stands for. */
function unifiedSectionToEdit(sec: UnifiedSection): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (sec.isCreate || oldP === null) {
    const target = newP ?? '';
    return {
      paths: [target],
      run: (tree) => {
        if (tree.text(target) !== null) return { code: 'exists', file: target };
        tree.set(target, creationText(sec.hunks));
        return null;
      },
    };
  }
  if (sec.isDelete || newP === null) {
    const target = oldP as string;
    return {
      paths: [target],
      run: (tree) => {
        if (tree.text(target) === null) return { code: 'missing', file: target };
        tree.del(target);
        return null;
      },
    };
  }
  if (oldP !== newP) {
    const from = oldP as string;
    const to = newP as string;
    return {
      paths: [from, to],
      run: (tree, strict) => {
        const cur = tree.text(from);
        if (cur === null) return { code: 'missing', file: from };
        if (tree.text(to) !== null) return { code: 'exists', file: to };
        const done = applyUnifiedHunks(splitDocText(cur), sec.hunks, strict);
        if (!done.ok) return { code: 'no-match', file: from };
        tree.set(to, joinDocText(done.doc));
        tree.del(from);
        tree.noteMove(from, to);
        return null;
      },
    };
  }
  const target = oldP as string;
  return {
    paths: [target],
    run: (tree, strict) => {
      const cur = tree.text(target);
      if (cur === null) return { code: 'missing', file: target };
      const done = applyUnifiedHunks(splitDocText(cur), sec.hunks, strict);
      if (!done.ok) return { code: 'no-match', file: target };
      tree.set(target, joinDocText(done.doc));
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                             */
/* ------------------------------------------------------------------ */

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** A marker line, matched with its trailing whitespace removed. */
function isMarker(line: string, marker: string): boolean {
  return line.replace(/[ \t]+$/, '') === marker;
}

/** Read a patch's SEARCH/REPLACE blocks. */
function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const searchIdx = i;
    let pathLine = -1;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      pathLine = j;
      break;
    }
    let path: string;
    if (pathLine >= 0) path = lines[pathLine].trim();
    else if (blocks.length > 0) path = blocks[blocks.length - 1].path;
    else throw new PatchFault(searchIdx + 1);
    let sep = -1;
    let end = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (isMarker(lines[j], '<<<<<<< SEARCH')) break;
      if (sep === -1 && isMarker(lines[j], '=======')) {
        sep = j;
        continue;
      }
      if (sep !== -1 && isMarker(lines[j], '>>>>>>> REPLACE')) {
        end = j;
        break;
      }
    }
    if (sep === -1 || end === -1) throw new PatchFault(searchIdx + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map(searchBlockToEdit);
}

/** One SEARCH/REPLACE block as the edit it stands for. */
function searchBlockToEdit(block: SearchBlock): Edit {
  const target = block.path;
  if (block.oldLines.length === 0) {
    return {
      paths: [target],
      run: (tree) => {
        if (tree.text(target) !== null) return { code: 'exists', file: target };
        tree.set(target, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
        return null;
      },
    };
  }
  return {
    paths: [target],
    run: (tree, strict) => {
      const cur = tree.text(target);
      if (cur === null) return { code: 'missing', file: target };
      const doc = splitDocText(cur);
      const found = locateUnique(doc.lines, block.oldLines, strict);
      if (found === null) return { code: 'no-match', file: target };
      if (found === 'many') return { code: 'ambiguous', file: target };
      const split: BodySplit = { oldLines: block.oldLines, newLines: block.newLines, ctxOf: block.newLines.map(() => -1) };
      const repl = buildReplacement(doc.lines, found.at, found.tier, split);
      tree.set(target, joinDocText(applyChange(doc, found.at, block.oldLines.length, repl, doc.trailing)));
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                       */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
}

/** Read a V4A patch's lines into its sections. */
function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new PatchFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new PatchFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new PatchFault(lines.length + 1);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && lines[i].trim() === '') i++;
    if (i >= last) break;
    const header = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (header.startsWith('*** Add File: ')) {
      kind = 'add';
      path = header.slice('*** Add File: '.length).trim();
    } else if (header.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = header.slice('*** Delete File: '.length).trim();
    } else if (header.startsWith('*** Update File: ')) {
      kind = 'update';
      path = header.slice('*** Update File: '.length).trim();
    } else {
      throw new PatchFault(i + 1);
    }
    const headerLine = i + 1;
    i++;
    const rawIdx: number[] = [];
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      rawIdx.push(i);
      i++;
    }
    while (rawIdx.length > 0 && lines[rawIdx[rawIdx.length - 1]].trim() === '') rawIdx.pop();
    sections.push(parseV4aSection(kind, path, headerLine, rawIdx.map((ix) => ({ no: ix + 1, text: lines[ix] }))));
  }
  return sections.map(v4aSectionToEdit);
}

/** One V4A section's lines, taken apart into what its kind needs. */
function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, headerLine: number, raw: Array<{ no: number; text: string }>): V4aSection {
  if (kind === 'add') {
    const out: string[] = [];
    for (const { no, text } of raw) {
      if (text.startsWith('+')) out.push(text.slice(1));
      else if (text === '') out.push('');
      else throw new PatchFault(no);
    }
    return { kind, path, headerLine, moveTo: null, lines: out, chunks: [] };
  }
  if (kind === 'delete') {
    for (const { no } of raw) throw new PatchFault(no);
    return { kind, path, headerLine, moveTo: null, lines: [], chunks: [] };
  }
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let idx = 0;
  if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
    moveTo = raw[0].text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  let current: V4aChunk | null = null;
  let sawChunk = false;
  for (; idx < raw.length; idx++) {
    const { no, text } = raw[idx];
    if (text.trim() === '*** End of File') {
      if (current === null) throw new PatchFault(no);
      current.eof = true;
      chunks.push(current);
      current = null;
      continue;
    }
    if (text.startsWith('@@')) {
      if (current !== null) {
        chunks.push(current);
        current = null;
      }
      const anchorText = text.slice(2).trim();
      current = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
      sawChunk = true;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (current === null) {
        if (sawChunk) throw new PatchFault(no);
        current = { anchor: null, body: [], eof: false };
        sawChunk = true;
      }
      const flavor = text === '' || text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'del' : 'add';
      current.body.push({ flavor, text: text === '' ? '' : text.slice(1) });
      continue;
    }
    throw new PatchFault(no);
  }
  if (current !== null) chunks.push(current);
  if (chunks.length === 0 && moveTo === null) throw new PatchFault(headerLine);
  return { kind, path, headerLine, moveTo, lines: [], chunks };
}

/** One V4A section as the edit it stands for. */
function v4aSectionToEdit(sec: V4aSection): Edit {
  if (sec.kind === 'add') {
    return {
      paths: [sec.path],
      run: (tree) => {
        if (tree.text(sec.path) !== null) return { code: 'exists', file: sec.path };
        tree.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
        return null;
      },
    };
  }
  if (sec.kind === 'delete') {
    return {
      paths: [sec.path],
      run: (tree) => {
        if (tree.text(sec.path) === null) return { code: 'missing', file: sec.path };
        tree.del(sec.path);
        return null;
      },
    };
  }
  const paths = sec.moveTo === null ? [sec.path] : [sec.path, sec.moveTo];
  return {
    paths,
    run: (tree, strict) => {
      const cur = tree.text(sec.path);
      if (cur === null) return { code: 'missing', file: sec.path };
      if (sec.moveTo !== null && tree.text(sec.moveTo) !== null) return { code: 'exists', file: sec.moveTo };
      let doc = splitDocText(cur);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        const split = splitBodyItems(chunk.body);
        if (chunk.anchor !== null) {
          const ai = locateAnchor(doc.lines, chunk.anchor, cursor, strict);
          if (ai === null) return { code: 'no-match', file: sec.path };
          cursor = ai + 1;
        }
        if (split.oldLines.length === 0) {
          const at = chunk.eof ? doc.lines.length : cursor;
          doc = applyChange(doc, at, 0, split.newLines, doc.trailing);
          cursor = at + split.newLines.length;
        } else {
          const found = locateV4a(doc.lines, split.oldLines, cursor, strict, chunk.eof);
          if (found === null) return { code: 'no-match', file: sec.path };
          const repl = buildReplacement(doc.lines, found.at, found.tier, split);
          doc = applyChange(doc, found.at, split.oldLines.length, repl, doc.trailing);
          cursor = found.at + repl.length;
        }
      }
      const out = joinDocText(doc);
      if (sec.moveTo !== null) {
        tree.set(sec.moveTo, out);
        tree.del(sec.path);
        tree.noteMove(sec.path, sec.moveTo);
      } else {
        tree.set(sec.path, out);
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                        */
/* ------------------------------------------------------------------ */

/** One JSON edit object, checked against what its command needs. A wrong
    command or a missing or mistyped key is a fault at `faultLine`. */
function jsonEditFrom(value: unknown, faultLine: number): Edit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PatchFault(faultLine);
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') throw new PatchFault(faultLine);
  if (typeof obj.command !== 'string') throw new PatchFault(faultLine);
  const target = obj.path as string;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw new PatchFault(faultLine);
    const text = obj.file_text as string;
    return {
      paths: [target],
      run: (tree) => {
        if (tree.text(target) !== null) return { code: 'exists', file: target };
        tree.set(target, text);
        return null;
      },
    };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new PatchFault(faultLine);
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') throw new PatchFault(faultLine);
    const oldStr = obj.old_str as string;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return {
      paths: [target],
      run: (tree) => {
        const cur = tree.text(target);
        if (cur === null) return { code: 'missing', file: target };
        const isCrlf = splitDocText(cur).eol === '\r\n';
        let text = cur;
        let oldS = oldStr;
        let newS = newStr;
        if (isCrlf) {
          text = cur.replace(/\r\n/g, '\n');
          oldS = oldStr.replace(/\r\n/g, '\n');
          newS = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let from = 0;
        while (true) {
          const at = text.indexOf(oldS, from);
          if (at === -1) break;
          count++;
          if (count > 1) break;
          from = at + 1;
        }
        if (count === 0) return { code: 'no-match', file: target };
        if (count > 1) return { code: 'ambiguous', file: target };
        const at = text.indexOf(oldS);
        let out = text.slice(0, at) + newS + text.slice(at + oldS.length);
        if (isCrlf) out = out.replace(/\n/g, '\r\n');
        tree.set(target, out);
        return null;
      },
    };
  }
  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) throw new PatchFault(faultLine);
    if (typeof obj.new_str !== 'string') throw new PatchFault(faultLine);
    const lineNo = obj.insert_line as number;
    const newStr = obj.new_str as string;
    return {
      paths: [target],
      run: (tree) => {
        const cur = tree.text(target);
        if (cur === null) return { code: 'missing', file: target };
        const doc = splitDocText(cur);
        if (lineNo < 0 || lineNo > doc.lines.length) return { code: 'no-match', file: target };
        const ins = splitPatchLines(newStr);
        const lines = [...doc.lines.slice(0, lineNo), ...ins, ...doc.lines.slice(lineNo)];
        tree.set(target, joinDocText({ lines, eol: doc.eol, trailing: doc.trailing }));
        return null;
      },
    };
  }
  throw new PatchFault(faultLine);
}

/** Read a JSON patch: one array of edit objects, or one edit object a
    line, blank lines ignored. */
function parseJson(lines: string[], fullText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return [];
  const firstCh = lines[firstIdx].trimStart()[0];
  if (firstCh === '[') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fullText);
    } catch {
      throw new PatchFault(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw new PatchFault(firstIdx + 1);
    return parsed.map((item) => jsonEditFrom(item, firstIdx + 1));
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new PatchFault(i + 1);
    }
    edits.push(jsonEditFrom(obj, i + 1));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection, the command line, and the run (sections 1-4, 10) */
/* ------------------------------------------------------------------ */

const KNOWN_FORMATS = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

/** The first of the detection rules that holds, or null when none does. */
function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => l.trim() !== '');
  if (first !== undefined) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const ch = first.trimStart()[0];
    if (ch === '[' || ch === '{') return 'json';
  }
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

interface Outcome {
  code: number;
  lines: string[];
}

const usageOut: Outcome = { code: 2, lines: ['error: usage'] };

/** Run the CLI on these arguments. Returns the exit code and the lines
    for standard output. */
function main(argv: string[]): Outcome {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOfOpts = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (!endOfOpts && arg === '--') {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return usageOut;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return usageOut;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return usageOut;
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (!KNOWN_FORMATS.has(v)) return usageOut;
        format = v;
      } else {
        return usageOut;
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return usageOut;

  let patchText: string;
  const patchArg = positional[0];
  if (patchArg === undefined || patchArg === '-') {
    patchText = fs.readFileSync(0, 'utf8');
  } else {
    try {
      patchText = fs.readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, lines: ['error: no-patch'] };
    }
  }

  const lines = splitPatchLines(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const found = detectFormat(lines);
    if (found === null) return { code: 2, lines: ['error: format'] };
    fmt = found;
  }
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof PatchFault) return { code: 2, lines: [`error: parse ${e.patchLine}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, lines: ['error: parse 1'] };

  const tree = new PatchTree();
  const issues: EditIssue[] = [];
  for (const edit of edits) {
    let issue: EditIssue | null = null;
    for (const p of edit.paths) {
      if (!isSafe(p)) {
        issue = { code: 'unsafe', file: p };
        break;
      }
    }
    if (issue === null) issue = edit.run(tree, strict);
    if (issue !== null) issues.push(issue);
  }
  if (issues.length > 0) {
    return {
      code: 1,
      lines: [...issues.map((x) => `error: ${x.code} ${x.file}`), `failed: ${issues.length} of ${edits.length} edits`],
    };
  }
  const rows = tree.changeRows();
  if (!check) tree.writeAll();
  return { code: 0, lines: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const runner = await import('./runner.ts');
  await runner.runTrial(envUrl);
} else {
  const outcome = main(process.argv.slice(2));
  process.stdout.write(outcome.lines.map((l) => l + '\n').join(''));
  process.exitCode = outcome.code;
}
