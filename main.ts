// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7), V4A patches (section 8), line matching at three tiers (section 5), and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- SPEC sections 3 and 5: file lines and three-tier matching ----

interface FileData {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileData {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFileData(d: FileData): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function findOcc(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const no = o.map((l) => normLine(l, t));
    const nf = fileLines.map((l) => normLine(l, t));
    const pos: number[] = [];
    for (let i = 0; i + o.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (nf[i + j] !== no[j]) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function findOccFrom(fileLines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const no = o.map((l) => normLine(l, t));
    const nf = fileLines.map((l) => normLine(l, t));
    const pos: number[] = [];
    for (let i = from; i + o.length <= fileLines.length; i++) {
      if (eof && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (nf[i + j] !== no[j]) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function findSingle(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const na = normLine(anchor, t);
    for (let i = from; i < fileLines.length; i++) {
      if (normLine(fileLines[i]!, t) === na) return i;
    }
  }
  return -1;
}

type NewItem = { ctx: true; off: number } | { ctx: false; text: string };

function applyAt(file: FileData, oLen: number, pos: number, items: NewItem[], tier: number, oFirst: string): void {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(file.lines[pos] ?? '');
    p = leadingWs(oFirst);
  }
  for (const it of items) {
    if (it.ctx) out.push(file.lines[pos + it.off]!);
    else if (tier === 2) {
      const t = it.text;
      out.push(t !== '' && t.trim() !== '' && t.startsWith(p) ? f + t.slice(p.length) : t);
    } else out.push(it.text);
  }
  file.lines.splice(pos, oLen, ...out);
}

// ---- SPEC section 6: unified diffs ----

interface Hunk {
  a: number;
  oLines: string[];
  nItems: NewItem[];
  slashAfterCtxNew: boolean;
  slashAfterPlus: boolean;
  plusCount: number;
}

interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function diffPath(s: string): string | null {
  let t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  if (t === '/dev/null') return null;
  return t;
}

function parseHunkBody(lines: string[], j: number): { hunk: Hunk; next: number } {
  type BK = 'ctx' | 'old' | 'new' | 'slash' | 'empty';
  const kinds: BK[] = [];
  const texts: string[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') { kinds.push('empty'); texts.push(''); k++; continue; }
    const c = l[0]!;
    if (c === ' ') { kinds.push('ctx'); texts.push(l.slice(1)); k++; continue; }
    if (c === '-') { kinds.push('old'); texts.push(l.slice(1)); k++; continue; }
    if (c === '+') { kinds.push('new'); texts.push(l.slice(1)); k++; continue; }
    if (c === '\\') { kinds.push('slash'); texts.push(l); k++; continue; }
    break;
  }
  while (kinds.length > 0 && kinds[kinds.length - 1] === 'empty') {
    kinds.pop();
    texts.pop();
  }
  const oLines: string[] = [];
  const nItems: NewItem[] = [];
  let plusCount = 0;
  for (let n = 0; n < kinds.length; n++) {
    const kind = kinds[n]!;
    const text = texts[n]!;
    if (kind === 'ctx' || kind === 'empty') {
      oLines.push(text);
      nItems.push({ ctx: true, off: oLines.length - 1 });
    } else if (kind === 'old') oLines.push(text);
    else if (kind === 'new') {
      nItems.push({ ctx: false, text });
      plusCount++;
    }
  }
  let slashAfterCtxNew = false;
  let slashAfterPlus = false;
  for (let n = kinds.length - 1; n >= 0; n--) {
    if (kinds[n] === 'ctx' || kinds[n] === 'empty' || kinds[n] === 'new') {
      slashAfterCtxNew = n + 1 < kinds.length && kinds[n + 1] === 'slash';
      break;
    }
  }
  for (let n = kinds.length - 1; n >= 0; n--) {
    if (kinds[n] === 'new') {
      slashAfterPlus = n + 1 < kinds.length && kinds[n + 1] === 'slash';
      break;
    }
  }
  return { hunk: { a: 0, oLines, nItems, slashAfterCtxNew, slashAfterPlus, plusCount }, next: k };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const parseErr = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) parseErr(i + 1);
      cur = { pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, gitOld: m[1]!, gitNew: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      cur = { pairOld: diffPath(line.slice(4)), pairNew: diffPath(lines[i + 1]!.slice(4)), renOld: undefined, renNew: undefined, gitOld: undefined, gitNew: undefined, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm || cur === null) parseErr(i + 1);
      const { hunk, next } = parseHunkBody(lines, i + 1);
      hunk.a = parseInt(hm[1]!, 10);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) parseErr(i + 2);
      if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      else if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim() === '/dev/null' ? null : line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim() === '/dev/null' ? null : line.slice(10).trim();
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply one hunk to the file's lines; returns N.length - O.length. Throws Fail('no-match', path). */
function applyHunk(file: FileData, hunk: Hunk, d: number, strict: boolean, path: string): number {
  if (hunk.oLines.length > 0) {
    const occ = findOcc(file.lines, hunk.oLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = occ.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const touchesEnd = best + hunk.oLines.length === file.lines.length;
    applyAt(file, hunk.oLines.length, best, hunk.nItems, occ.tier, hunk.oLines[0]!);
    if (touchesEnd) file.final = !hunk.slashAfterCtxNew;
    return hunk.nItems.length - hunk.oLines.length;
  }
  const ins = Math.max(0, Math.min(hunk.a + d, file.lines.length));
  const touchesEnd = ins === file.lines.length;
  const add = hunk.nItems.map((it) => (it.ctx ? file.lines[ins + it.off] ?? '' : it.text));
  file.lines.splice(ins, 0, ...add);
  if (touchesEnd) file.final = !hunk.slashAfterCtxNew;
  return hunk.nItems.length;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitOld;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitNew;
    const create = oldP === null || s.newFile;
    const del = !create && (newP === null || s.deletedFile);
    if (create) {
      const plusLines: string[] = [];
      let slashAfterLastPlus = false;
      for (const h of s.hunks) {
        for (const it of h.nItems) if (!it.ctx) plusLines.push(it.text);
        if (h.plusCount > 0) slashAfterLastPlus = h.slashAfterPlus;
      }
      const content = plusLines.length === 0 ? '' : plusLines.join('\n') + (slashAfterLastPlus ? '' : '\n');
      return (tree: Tree): void => {
        if (newP === null || newP === undefined) return;
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, content);
      };
    }
    if (del) {
      return (tree: Tree): void => {
        if (oldP === null || oldP === undefined) return;
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      };
    }
    const isMove = oldP !== newP;
    return (tree: Tree): void => {
      if (typeof oldP !== 'string' || typeof newP !== 'string') return;
      const oldPath = oldP;
      const newPath = newP;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const file = parseFile(cur);
      let d = 0;
      for (const h of s.hunks) d += applyHunk(file, h, d, strict, oldPath);
      const out = writeFileData(file);
      if (isMove) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

// ---- SPEC section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const file = parseFile(cur);
      const occ = findOcc(file.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', p);
      if (occ.pos.length > 1) throw new Fail('ambiguous', p);
      const items: NewItem[] = newLines.map((t) => ({ ctx: false, text: t }));
      applyAt(file, oldLines.length, occ.pos[0]!, items, occ.tier, oldLines[0]!);
      tree.now.set(p, writeFileData(file));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- SPEC section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oLines: string[];
  nItems: NewItem[];
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let n = lines.length - 1; n >= 0; n--) {
    if (!blank(lines[n]!)) {
      last = n;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^(\*\*\* (Add File|Delete File|Update File): )(.*)$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[2]!;
    const path = m[3]!.trim();
    const sectionLine = i + 1;
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (/^\*\*\* (Add File|Delete File|Update File): /.test(l)) break;
      if (l.trim() === '*** End Patch') break;
      raw.push(l);
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(buildV4aEdit(kind, path, raw, sectionLine, strict, moves));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function buildV4aEdit(kind: string, path: string, raw: string[], sectionLine: number, strict: boolean, moves: Array<[string, string]>): Edit {
  const lineNo = (k: number): number => sectionLine + 1 + k;
  if (kind === 'Add File') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${lineNo(k)}`);
    }
    const content = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content);
    };
  }
  if (kind === 'Delete File') {
    for (let k = 0; k < raw.length; k++) {
      if (!blank(raw[k]!)) throw new Exit2(`error: parse ${lineNo(k)}`);
    }
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update File
  let k = 0;
  let moveTo: string | null = null;
  if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.slice('*** Move to: '.length).trim();
    k++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; k < raw.length; k++) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oLines: [], nItems: [] };
      chunks.push(cur);
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) {
          if (l === '') continue;
          throw new Exit2(`error: parse ${lineNo(k)}`);
        }
        cur = { anchor: null, eof: false, oLines: [], nItems: [] };
        chunks.push(cur);
      }
      if (l === '') {
        cur.oLines.push('');
        cur.nItems.push({ ctx: true, off: cur.oLines.length - 1 });
      } else if (l[0] === ' ') {
        const t = l.slice(1);
        cur.oLines.push(t);
        cur.nItems.push({ ctx: true, off: cur.oLines.length - 1 });
      } else if (l[0] === '-') cur.oLines.push(l.slice(1));
      else cur.nItems.push({ ctx: false, text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(k)}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  const move = moveTo;
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (move !== null && !safe(move)) throw new Fail('unsafe', move);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const file = parseFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(file.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.oLines.length === 0) {
        const ins = ch.eof ? file.lines.length : cursor;
        const add = ch.nItems.map((it) => (it.ctx ? '' : it.text));
        file.lines.splice(ins, 0, ...add);
        cursor = ins + add.length;
      } else {
        const occ = findOccFrom(file.lines, ch.oLines, cursor, strict, ch.eof);
        if (occ === null) throw new Fail('no-match', path);
        const pos = occ.pos[0]!;
        applyAt(file, ch.oLines.length, pos, ch.nItems, occ.tier, ch.oLines[0]!);
        cursor = pos + ch.nItems.length;
      }
    }
    const out = writeFileData(file);
    if (move !== null) {
      tree.now.set(path, null);
      tree.now.set(move, out);
      moves.push([path, move]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.get(oldP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(`D:${oldP}`);
      suppressed.add(`A:${newP}`);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const k = was === null ? 'A' : now === null ? 'D' : 'M';
    if (suppressed.has(`${k}:${p}`)) continue;
    rows.push({ key: p, line: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
