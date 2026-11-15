// A standalone GitHub-compatible git forge in one process, standard library only.
//
// Surfaces, all served from one in-memory store:
//   git smart HTTP  /{owner}/{repo}.git  (upload-pack v2 + v0, receive-pack v0)
//   REST v3         /api/v3              (repos, branches, commits, contents, issues,
//                                         comments, labels, pull requests, merges)
//   GraphQL v4      /api/graphql         (the documents gh and github-mcp-server send)
//   MCP             /mcp                 (JSON-RPC 2.0 streamable HTTP, revision 2026-07-28)
//
// Determinism: every id, timestamp and counter in stored state is a fixed constant
// or a sequence number. No wall clock, no Math.random, no random UUIDs anywhere in
// state. The only identity the suite's token names is derived from the contest's
// one fixed scenario seed, which is public in the kit.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The token owner, derived from the fixed scenario seed
// ---------------------------------------------------------------------------

// The scenario seed is a public constant of the contest; every generated login
// derives from it, so the viewer login below is the same on every trial.
const SEED = 0x6a09e667f3bcc909n;
const U64 = 0xffffffffffffffffn;

function fnv(label: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < label.length; i += 1) {
    h ^= BigInt(label.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64;
  }
  return h;
}

function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}

class SeedStream {
  #s: bigint;
  constructor(seed: bigint) {
    const m = seed & U64;
    this.#s = m === 0n ? SEED : m;
  }
  u32(): number {
    let x = this.#s;
    x = (x ^ (x >> 12n)) & U64;
    x = (x ^ (x << 25n)) & U64;
    x = (x ^ (x >> 27n)) & U64;
    this.#s = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64) >> 32n);
  }
  int(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.u32();
      if (v < limit) return v % max;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

const GIVEN_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris',
  'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa',
  'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const FAMILY_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm',
  'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters',
  'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz',
  'zimmer',
];

function scenarioLogins(): string[] {
  const rng = new SeedStream(mix64(SEED ^ fnv('users')));
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(GIVEN_NAMES);
    const last = rng.pick(FAMILY_NAMES);
    let login = `${first}${last}`;
    let suffix = 2;
    while (used.has(login)) {
      login = `${first}${last}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    out.push(login);
  }
  return out;
}

const LOGINS = scenarioLogins();
const VIEWER_LOGIN = LOGINS[0];
const STRANGER_LOGIN = LOGINS[2];

// Fixed identity and clock for every commit this forge authors itself. The suite
// drives commit bytes through git, so these only appear on REST/GraphQL commits.
const FORGE_AUTHOR = 'Forge <forge@example.invalid>';
const FORGE_EPOCH = 1700000000;
const FIXED_STAMP = '2025-01-01T00:00:00Z';
const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------------------
// Git objects: hashing, parsing, building, reachability
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObj(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

interface TreeEnt { mode: string; name: string; oid: string; }

function parseTree(data: Buffer): TreeEnt[] {
  const out: TreeEnt[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    out.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

function sortKey(e: TreeEnt): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

function buildTree(entries: TreeEnt[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`);
  lines.push(`committer ${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

interface TagView { object: string; type: string; tag: string; tagger: string; message: string; }

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

type Lookup = (oid: string) => GitObj | undefined;

// The full closure of `roots`: every object reachable by following tree entries,
// tag targets and (when `followParents` is true) commit parents. A depth-limited
// fetch already names exactly the commits it may send, so its closure must follow
// trees and tags only — walking parents there would silently re-attach the
// history the depth limit cut off.
function reachable(roots: Iterable<string>, lookup: Lookup, followParents = true): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (followParents) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Packfiles: read (plain + OFS/REF deltas) and write (plain objects)
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const res = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number; typeCode: number; size: number; data: Buffer;
  baseOffset?: number; baseOid?: string;
  resolved?: Buffer; resolvedType?: ObjType; oid?: string;
}

// One shared empty buffer: readPack and decodePkts used to allocate a fresh
// zero-length buffer per pack entry and per flush line.
const EMPTY_BUF = Buffer.alloc(0);

function readPack(pack: Buffer, resolveBase?: Lookup): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  // Compare the trailer as bytes: two hex round-trips per pack for nothing.
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!computed.equals(pack.subarray(trailerStart))) throw new Error('pack trailer checksum mismatch');
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const header = readVarint(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: EMPTY_BUF };
    if (typeCode === 6) {
      const base = readOfsBase(pack, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack has trailing bytes');
  const objects = new Map<string, GitObj>();
  // Only ref-deltas look a base up by oid; a pack without one never needs
  // the map, so build it lazily instead of paying a set per entry.
  const hasRefDelta = raw.some((e) => e.typeCode === 7);
  const byOid = hasRefDelta ? new Map<string, RawEntry>() : null;
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid!.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error('ref-delta base missing');
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObj(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    if (byOid) byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(lines: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  // One allocation for the whole frame: measure first, then write the length
  // prefixes and payloads into a single buffer. A pkt per line would concat
  // twice per line and the frame once more, and this runs on every git
  // advertisement, ls-refs answer, fetch and push report.
  let total = 0;
  for (const line of lines) {
    total += 4 + (line === 'flush' || line === 'delim' ? 0 : typeof line === 'string' ? Buffer.byteLength(line) : line.length);
  }
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (const line of lines) {
    if (line === 'flush') { out.write('0000', off, 4, 'ascii'); off += 4; continue; }
    if (line === 'delim') { out.write('0001', off, 4, 'ascii'); off += 4; continue; }
    const body = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
    const len = body.length + 4;
    out.write(len.toString(16).padStart(4, '0'), off, 4, 'ascii');
    body.copy(out, off + 4);
    off += len;
  }
  return out;
}

interface PktItem { kind: 'data' | 'flush' | 'delim'; payload: Buffer; }

// Decode a whole buffer of pkt-lines. Stops at a non-pkt-line tail (the pack
// section of a receive-pack body) and reports where it stopped.
function decodePkts(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { items.push({ kind: 'flush', payload: EMPTY_BUF }); off += 4; continue; }
    if (head === '0001') { items.push({ kind: 'delim', payload: EMPTY_BUF }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    items.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { items, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface Label { name: string; color: string; }
interface Comment { id: number; body: string; }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Comment[]; seq: number;
  // Cached serializations of issueView, rebuilt on any mutation (PATCH,
  // comment add, label recolor). _json has no trailing newline (list join);
  // _buf is the full response body with the newline.
  _json: string | null; _buf: Buffer | null;
}
interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number; }
interface Pull {
  number: number; title: string; body: string; head: string; base: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null;
  headSha: string; baseSha: string; mergeSha: string | null;
  files: PullFile[]; seq: number;
}
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean;
  defaultBranch: string; seq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  nextIssue: number; nextPull: number; nextComment: number;
  // Versions bumped whenever the thing they guard changes; they key the
  // fetch and ls-refs caches below. objVersion covers the object store,
  // refVersion the ref map.
  objVersion: number;
  refVersion: number;
  // Cached fetch responses (full upload-pack reply buffers) keyed by
  // `objVersion|wants|depth|haves|shallow`, and cached ls-refs replies keyed
  // by `refVersion|prefixes`. The clone workload repeats the same fetch
  // fifty times on an unchanged repo; the pack (deflate + framing) is the
  // most expensive thing in it, so a cache hit skips it entirely.
  fetchCache: Map<string, Buffer>;
  lsRefsCache: Map<string, Buffer>;
  // Cached v0 advertisements keyed by service; a ref move bumps refVersion
  // and drops the entry, so a stale advertisement can never be served.
  advCache: Map<string, { version: number; buf: Buffer }>;
}

const repos = new Map<string, Repo>();
let repoSeq = 0;
let nextRepoId = 1000;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, description: string, priv: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description,
    priv,
    defaultBranch: 'main',
    seq: ++repoSeq,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    issueByNumber: new Map(),
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    objVersion: 0,
    refVersion: 0,
    fetchCache: new Map(),
    lsRefsCache: new Map(),
    advCache: new Map(),
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

// Move a ref and bump the ref version (the ls-refs cache keys on it).
function setRef(repo: Repo, name: string, oid: string): void {
  repo.refs.set(name, oid);
  repo.refVersion++;
}

function deleteRef(repo: Repo, name: string): void {
  repo.refs.delete(name);
  repo.refVersion++;
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObj(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    repo.objVersion++;
  }
  return oid;
}

// Flatten a tree into path -> {oid, mode} by walking it.
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  if (treeOid === EMPTY_TREE_OID) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

function treeOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  flattenTree(repo, parseCommit(obj.data).tree, '', out);
  return out;
}

// Rebuild a tree from a flat path map, creating intermediate trees.
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEnt[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    if (entries.length === 0) return EMPTY_TREE_OID;
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// Author one commit on a branch: replace the files in `changes` (null value
// deletes), keep everything else, move the branch ref. Returns the commit oid.
function authorCommit(
  repo: Repo,
  branch: string,
  message: string,
  changes: Map<string, Buffer | null>,
): string {
  const tip = refTip(repo, branch);
  const flat = tip ? treeOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
  for (const [path, data] of changes) {
    if (data === null) flat.delete(path);
    else flat.set(path, { oid: storeObject(repo, 'blob', data), mode: '100644' });
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const parents = tip ? [tip] : [];
  const commitOid = storeObject(repo, 'commit', buildCommit(treeOid, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.refVersion++;
  return commitOid;
}

// Walk a branch's history, newest first.
function branchHistory(repo: Repo, branch: string): string[] {
  const out: string[] = [];
  let cur = refTip(repo, branch);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    out.push(cur);
    cur = parseCommit(obj.data).parents[0];
  }
  return out;
}

// Is `anc` an ancestor of `tip` (or equal)? Walks the first-parent chain plus
// merges by full parent traversal.
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === anc) return true;
      queue.push(p);
    }
  }
  return false;
}

// Commits within `depth` generations of `tip` (depth 1 = the tip only).
function depthLimitedCommits(repo: Repo, tip: string, depth: number | undefined): Set<string> {
  const out = new Set<string>();
  const queue: [string, number][] = [[tip, 0]];
  while (queue.length > 0) {
    const [cur, gen] = queue.shift()!;
    if (out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.add(cur);
    if (depth === undefined || gen + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
    }
  }
  return out;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (const b of data) if (b === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

// Diff two flat trees: the changed files with line counts.
function diffFlat(
  repo: Repo,
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
): PullFile[] {
  const out: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = Math.max(1, lineCount(data));
      out.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const del = Math.max(1, lineCount(data));
      out.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
    } else if (b && h) {
      const bd = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const hd = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = Math.max(1, lineCount(hd));
      const del = Math.max(1, lineCount(bd));
      out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return out;
}

// Can this pull merge cleanly onto its base's current tip? A file the pull
// changed must still hold the pull base's bytes on the base branch.
function mergeConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = refTip(repo, pull.base);
  if (!baseTip) return true;
  const current = treeOfCommit(repo, baseTip);
  const pullBase = treeOfCommit(repo, pull.baseSha);
  for (const f of pull.files) {
    const now = current.get(f.filename);
    const was = pullBase.get(f.filename);
    if (f.status === 'removed') {
      if (now && (!was || now.oid !== was.oid)) return true;
    } else {
      if (was && (!now || now.oid !== was.oid)) return true;
      if (!was && now) return true;
    }
  }
  return false;
}

// Squash-merge a pull onto its base branch. Returns the merge commit oid.
function squashMerge(repo: Repo, pull: Pull): string {
  const baseTip = refTip(repo, pull.base)!;
  const flat = treeOfCommit(repo, baseTip);
  const headFlat = treeOfCommit(repo, pull.headSha);
  for (const f of pull.files) {
    if (f.status === 'removed') flat.delete(f.filename);
    else {
      const entry = headFlat.get(f.filename);
      if (entry) flat.set(f.filename, entry);
    }
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitOid = storeObject(repo, 'commit', buildCommit(treeOid, [baseTip], pull.title));
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  repo.refVersion++;
  return commitOid;
}

// ---------------------------------------------------------------------------
// JSON views of stored objects (REST + GraphQL share these shapes)
// ---------------------------------------------------------------------------

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function repoGid(repo: Repo): string {
  return gid('R', `${repo.owner}/${repo.name}`);
}

function issueGid(repo: Repo, n: number): string {
  return gid('I', `${repo.owner}/${repo.name}:${n}`);
}

function pullGid(repo: Repo, n: number): string {
  return gid('P', `${repo.owner}/${repo.name}:${n}`);
}

function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGid(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: FIXED_STAMP,
    updated_at: FIXED_STAMP,
    pushed_at: FIXED_STAMP,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: issueGid(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: repo.owner, id: 1000 },
    created_at: FIXED_STAMP,
    updated_at: FIXED_STAMP,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: pullGid(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: repo.owner, id: 1000 },
    created_at: FIXED_STAMP,
    updated_at: FIXED_STAMP,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body: body ?? '',
    state: 'open',
    labels,
    comments: [],
    seq: repoSeq + 1,
    _json: null,
    _buf: null,
  };
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  return issue;
}

// Drop an issue's cached serializations after a mutation. Called on PATCH,
// comment add, and (for every issue) label recolor, which the view reads.
function invalidateIssue(issue: Issue): void {
  issue._json = null;
  issue._buf = null;
}

// The serialized issueView, byte-identical to JSON.stringify(issueView(repo,
// issue)) but built directly: no view object, no label objects, no user
// object. The read workload asks for the same issue two thousand times; the
// first call pays the build and every later call reuses it.
function issueJson(repo: Repo, issue: Issue): string {
  if (issue._json !== null) return issue._json;
  const labels = issue.labels.length === 0
    ? '[]'
    : `[${issue.labels.map((name) => `{"name":${JSON.stringify(name)},"color":${JSON.stringify(repo.labels.get(name)?.color ?? 'ededed')}}`).join(',')}]`;
  const text = `{"id":${repo.id * 100000 + issue.number},"node_id":${JSON.stringify(issueGid(repo, issue.number))},"number":${issue.number},"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},"state":${JSON.stringify(issue.state)},"labels":${labels},"user":{"login":${JSON.stringify(repo.owner)},"id":1000},"created_at":${JSON.stringify(FIXED_STAMP)},"updated_at":${JSON.stringify(FIXED_STAMP)},"comments":${issue.comments.length},"html_url":${JSON.stringify(`https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`)},"url":${JSON.stringify(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`)}}`;
  issue._json = text;
  return text;
}

// The full response body for one issue (serialized view + newline), cached
// with the string so a GET sends a prebuilt Buffer.
function issueBuf(repo: Repo, issue: Issue): Buffer {
  if (issue._buf !== null) return issue._buf;
  const buf = Buffer.from(`${issueJson(repo, issue)}\n`, 'utf8');
  issue._buf = buf;
  return buf;
}

function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = refTip(repo, head);
  const baseSha = refTip(repo, base);
  if (!headSha || !baseSha) return null;
  const files = diffFlat(repo, treeOfCommit(repo, baseSha), treeOfCommit(repo, headSha));
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body: body ?? '',
    head,
    base,
    state: 'open',
    merged: false,
    mergedAt: null,
    headSha,
    baseSha,
    mergeSha: null,
    files,
    seq: repoSeq + 1,
  };
  repo.pulls.push(pull);
  return pull;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJsonText(res, status, `${JSON.stringify(body)}\n`, extra);
}

// Send an already-serialized JSON document (a cached issue, a list built from
// cached issues). One Buffer from the text, no re-stringify, no byteLength
// scan over the string.
function sendJsonText(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  sendBuf(res, status, Buffer.from(text, 'utf8'), 'application/json; charset=utf-8', extra);
}

// Send an already-built Buffer with the JSON headers. The request id is the
// only per-request header; the body (and its length) comes from the cache.
function sendBuf(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `forge-${++requestCounter}`,
    ...extra,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    // Small bodies arrive in one chunk; do not copy them through a concat.
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

// The request target, parsed without the URL constructor: the handlers only
// need the pathname and the query params, and `new URL` costs more than the
// routing around it. The query string is parsed lazily — most git requests
// carry none or a one-key query.
function urlOf(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  const raw = req.url ?? '/';
  const qi = raw.indexOf('?');
  const pathname = qi < 0 ? raw : raw.slice(0, qi);
  const query = qi < 0 ? '' : raw.slice(qi + 1);
  let params: URLSearchParams | null = null;
  return {
    pathname,
    get searchParams(): URLSearchParams {
      if (!params) params = new URLSearchParams(query);
      return params;
    },
  };
}

function bearerOk(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Split a path into decoded segments, dropping empty ones. Most paths carry
// no percent-escapes; skip the decode pass entirely for those.
function segments(pathname: string): string[] {
  const parts = pathname.split('/').filter((s) => s !== '');
  if (!pathname.includes('%')) return parts;
  return parts.map((s) => decodeURIComponent(s));
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  // segs[0] is 'api', segs[1] is 'v3'.
  const rest = segs.slice(2);

  // The API root and meta need no repository, but they do need the token.
  if (rest.length === 0) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    if (!bearerOk(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    if (!bearerOk(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return true; }
    sendJson(res, 200, { installed_version: '1.0.0', version: '1.0.0' });
    return true;
  }

  // Every other REST route requires the bearer token first.
  if (!bearerOk(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  // GET /api/v3/user — the token owner's identity.
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, type: 'User', name: VIEWER_LOGIN });
    return true;
  }

  // GET/POST /api/v3/user/repos — list (paginated) and create.
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const perPage = Math.max(1, num(query.get('per_page') ? Number(query.get('per_page')) : NaN) ?? 30);
      const page = Math.max(1, num(query.get('page') ? Number(query.get('page')) : NaN) ?? 1);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const extra: Record<string, string> = {};
      if (start + perPage < all.length) {
        const host = req.headers.host ?? 'forge';
        const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        extra.link = `<${next}>; rel="next"`;
      }
      sendJson(res, 200, slice.map(repoView), extra);
      return true;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = str(body.name);
      if (name === '') { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return true; }
      if (findRepo(VIEWER_LOGIN, name)) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      const repo = createRepoRecord(name, str(body.description), body.private === true);
      sendJson(res, 201, repoView(repo));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);
    const repo = owner === VIEWER_LOGIN ? findRepo(owner, name) : undefined;
    if (!repo) {
      // A body read first would hang a DELETE/PUT with no body; still answer 404.
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoView(repo)); return true; }
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.priv = body.private;
        sendJson(res, 200, repoView(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': `forge-${++requestCounter}` });
        res.end();
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // Branches.
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const out: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          if (ref.startsWith('refs/heads/')) {
            out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
          }
        }
        sendJson(res, 200, out);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = refTip(repo, tail[1]);
        if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // Commits.
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const branch = query.get('sha') ?? repo.defaultBranch;
      const history = branchHistory(repo, branch);
      const out = history.map((sha) => {
        const obj = repo.objects.get(sha)!;
        const c = parseCommit(obj.data);
        return { sha, commit: { message: c.message, author: { name: 'Forge', email: 'forge@example.invalid' }, committer: { name: 'Forge', email: 'forge@example.invalid' } }, parents: c.parents.map((p) => ({ sha: p })) };
      });
      sendJson(res, 200, out);
      return true;
    }

    // Git data: refs.
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        repo.refs.set(ref, sha);
        repo.refVersion++;
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // Contents.
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const branch = str(body.branch) || repo.defaultBranch;
        const message = str(body.message) || 'Update file';
        const contentB64 = str(body.content);
        let data: Buffer;
        try {
          data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' });
          return true;
        }
        const givenSha = str(body.sha);
        const tip = refTip(repo, branch);
        const flat = tip ? treeOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
        const existing = flat.get(filePath);
        if (givenSha !== '') {
          if (!existing || existing.oid !== givenSha) {
            sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
            return true;
          }
        }
        const isUpdate = existing !== undefined;
        // A contents write on a branch that does not exist yet creates it from
        // the default branch's tip (or from nothing when the repo is unborn).
        if (!tip && branch !== repo.defaultBranch) {
          const baseTip = refTip(repo, repo.defaultBranch);
          if (baseTip) { repo.refs.set(`refs/heads/${branch}`, baseTip); repo.refVersion++; }
        }
        const changes = new Map<string, Buffer | null>([[filePath, data]]);
        const commitSha = authorCommit(repo, branch, message, changes);
        const blobOid = storeObject(repo, 'blob', data);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: data.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const branch = ref ?? repo.defaultBranch;
        const tip = refTip(repo, branch);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const flat = treeOfCommit(repo, tip);
        const entry = flat.get(filePath);
        if (entry) {
          const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(),
            path: filePath, content: data.toString('base64'), sha: entry.oid,
          });
          return true;
        }
        // A directory: list its immediate children.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const kids = new Map<string, { type: string; oid: string }>();
        for (const [p, e] of flat) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash < 0) kids.set(rest2, { type: 'file', oid: e.oid });
          else kids.set(rest2.slice(0, slash), { type: 'dir', oid: '' });
        }
        if (kids.size === 0) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const out = [...kids.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, k]) => ({
          type: k.type, name: n, path: prefix + n, sha: k.oid === '' ? EMPTY_TREE_OID : k.oid, size: 0,
        }));
        sendJson(res, 200, out);
        return true;
      }
      if (method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const branch = str(body.branch) || repo.defaultBranch;
        const tip = refTip(repo, branch);
        const flat = tip ? treeOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
        if (!flat.has(filePath)) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const message = str(body.message) || 'Delete file';
        const commitSha = authorCommit(repo, branch, message, new Map([[filePath, null]]));
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // Labels.
    if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = str(body.name);
      if (name === '') { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
      const color = str(body.color) || 'ededed';
      repo.labels.set(name, { name, color });
      // A recolor changes every issue view that carries this label.
      for (const i of repo.issues) invalidateIssue(i);
      sendJson(res, 201, { name, color, description: '' });
      return true;
    }

    // Issues.
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const labels: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const l of body.labels) {
              const name = typeof l === 'string' ? l : isRecord(l) ? str(l.name) : '';
              if (name === '') continue;
              if (!repo.labels.has(name)) {
                sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
                return true;
              }
              labels.push(name);
            }
          }
          const issue = createIssueRecord(repo, str(body.title), str(body.body), labels);
          sendBuf(res, 201, issueBuf(repo, issue), 'application/json; charset=utf-8');
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'asc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => direction === 'desc' ? b.number - a.number : a.number - b.number);
          }
          const perPage = query.get('per_page') ? Math.max(1, Number(query.get('per_page'))) : 30;
          sendJsonText(res, 200, `[${list.slice(0, perPage).map((i) => issueJson(repo, i)).join(',')}]` + '\n');
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const n = Number(tail[1]);
      const issue = repo.issueByNumber.get(n);
      if (tail.length === 2) {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') { sendBuf(res, 200, issueBuf(repo, issue), 'application/json; charset=utf-8'); return true; }
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          invalidateIssue(issue);
          sendBuf(res, 200, issueBuf(repo, issue), 'application/json; charset=utf-8');
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (tail[2] === 'comments') {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const comment: Comment = { id: repo.nextComment++, body: str(body.body) };
          issue.comments.push(comment);
          invalidateIssue(issue);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: repo.owner } });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: repo.owner } })));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // Pull requests.
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const head = str(body.head);
          const base = str(body.base) || repo.defaultBranch;
          if (!refTip(repo, head) || !refTip(repo, base)) {
            sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
            return true;
          }
          const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
          if (existing) {
            sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this branch' });
            return true;
          }
          const pull = createPullRecord(repo, str(body.title), str(body.body), head, base);
          if (!pull) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
          sendJson(res, 201, pullView(repo, pull));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          const perPage = query.get('per_page') ? Math.max(1, Number(query.get('per_page'))) : 30;
          sendJson(res, 200, list.slice(0, perPage).map((p) => pullView(repo, p)));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const n = Number(tail[1]);
      const pull = repo.pulls.find((p) => p.number === n);
      if (tail.length === 2) {
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') { sendJson(res, 200, pullView(repo, pull)); return true; }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, pull.files.map((f) => ({
          filename: f.filename, status: f.status, additions: f.additions,
          deletions: f.deletions, changes: f.changes,
        })));
        return true;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is already closed' });
          return true;
        }
        // Consume the body (merge_method) so the socket stays clean.
        await readBody(req);
        if (mergeConflicts(repo, pull)) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return true;
        }
        const sha = squashMerge(repo, pull);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = FIXED_STAMP;
        pull.mergeSha = sha;
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack shallow multi_ack agent=forge/1.0'
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const tip = refTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return pktLines(lines);
  }
  let first = true;
  const headLine = `${tip ?? ZERO_OID} HEAD${first ? `\0${caps}` : ''}\n`;
  lines.push(headLine);
  first = false;
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      lines.push(`${target} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

// The v2 advertisement is five constant lines; build it once and reuse the
// buffer for every clone instead of re-framing it per request.
let V2_ADV: Buffer | null = null;
function v2Advertisement(): Buffer {
  if (!V2_ADV) {
    V2_ADV = pktLines([
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
      'agent=forge/1.0\n',
      'flush',
    ]);
  }
  return V2_ADV;
}

// The v0 advertisement for a service, cached per ref version: it depends only
// on the refs (versioned), the objects at those refs (immutable once stored),
// and the default branch (fixed at creation), so a ref move is the only thing
// that can stale it — and that bumps refVersion.
function v0AdvertisementCached(repo: Repo, service: string): Buffer {
  const hit = repo.advCache.get(service);
  if (hit && hit.version === repo.refVersion) return hit.buf;
  const buf = v0Advertisement(repo, service);
  repo.advCache.set(service, { version: repo.refVersion, buf });
  return buf;
}

// The objects a fetch must send for `wants`, given `haves` and a depth limit.
function fetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  // What the client already holds: the closure of its haves, but a shallow
  // boundary is a cutoff — the client holds the boundary commit and its tree,
  // never the boundary's parents, so a deepen must still deliver them.
  const cutoff = new Set(oldShallow);
  const held = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (!cutoff.has(oid)) for (const p of c.parents) queue.push(p);
        queue.push(c.tree);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      }
    }
  }
  const wanted = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      wanted.add(want);
      const target = parseTag(obj.data).object;
      const commits = depthLimitedCommits(repo, target, depth);
      for (const c of commits) wanted.add(c);
      if (depth !== undefined) {
        for (const c of commits) {
          const co = repo.objects.get(c);
          if (!co) continue;
          for (const p of parseCommit(co.data).parents) {
            if (!commits.has(p)) shallow.add(c);
          }
        }
      }
      continue;
    }
    if (obj.type !== 'commit') { wanted.add(want); continue; }
    const commits = depthLimitedCommits(repo, want, depth);
    for (const c of commits) wanted.add(c);
    if (depth !== undefined) {
      for (const c of commits) {
        const co = repo.objects.get(c);
        if (!co) continue;
        const parents = parseCommit(co.data).parents;
        if (parents.some((p) => !commits.has(p))) shallow.add(c);
      }
      for (const old of oldShallow) {
        if (commits.has(old)) unshallow.add(old);
      }
    }
  }
  // The objects to send are the closure of exactly the commits `wanted` names:
  // their trees and blobs, never their parents — `wanted` is already depth
  // limited, and following parents here would leak the cut-off history (a
  // depth-1 clone would carry the parent and grandparent, a deepen would
  // re-send the grandparent). `held` above already removed what the client has.
  const closure = reachable(wanted, (oid) => repo.objects.get(oid), false);
  const out: GitObj[] = [];
  for (const oid of closure) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) out.push(obj);
  }
  return { objects: out, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

// Frame bytes as sideband band-1 pkt-lines in one allocation, optionally with
// a trailing flush. The old shape built a Buffer per chunk (band byte +
// piece, then a pkt-line around it, then a frame concat) — three concats
// per chunk on every fetch and push report.
function band1(data: Buffer, flush = false): Buffer {
  const CHUNK = 65515;
  const chunks = Math.max(1, Math.ceil(data.length / CHUNK));
  let total = flush ? 4 : 0;
  for (let i = 0; i < chunks; i++) total += 4 + 1 + Math.min(CHUNK, data.length - i * CHUNK);
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK;
    const piece = data.subarray(start, Math.min(data.length, start + CHUNK));
    const len = piece.length + 1 + 4;
    out.write(len.toString(16).padStart(4, '0'), off, 4, 'ascii');
    out[off + 4] = 1;
    piece.copy(out, off + 5);
    off += len;
  }
  if (flush) { out.write('0000', off, 4, 'ascii'); off += 4; }
  return out;
}

// Split a pack into sideband band-1 pkt-lines (each chunk fits a pkt-line).
function sidebandPack(pack: Buffer): Buffer {
  if (pack.length === 0) {
    // An empty pack is still a pack: send its bytes so the client can parse it.
    return band1(writePack([]));
  }
  return band1(pack);
}

interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined;
}

function parseFetchLines(items: PktItem[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { items } = decodePkts(body);
  const first = items.find((i) => i.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (first.startsWith('command=ls-refs')) {
    const prefixes: string[] = [];
    for (const item of items) {
      if (item.kind !== 'data') continue;
      const line = item.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const lines: (string | 'flush')[] = [];
    const tip = refTip(repo, repo.defaultBranch);
    if (prefixes.length === 0) {
      if (tip) lines.push(`${tip} HEAD symref-target:refs/heads/main\n`);
      else lines.push(`unborn HEAD symref-target:refs/heads/main\n`);
    }
    for (const [name, oid] of [...repo.refs.entries()].sort()) {
      if (!keep(name)) continue;
      const obj = repo.objects.get(oid);
      let line = `${oid} ${name}`;
      if (obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
      lines.push(`${line}\n`);
    }
    lines.push('flush');
    const cacheKey = `${repo.refVersion}|${prefixes.join(',')}`;
    const cached = repo.lsRefsCache.get(cacheKey);
    if (cached) { sendRaw(res, 200, 'application/x-git-upload-pack-result', cached); return; }
    const buf = pktLines(lines);
    repo.lsRefsCache.set(cacheKey, buf);
    sendRaw(res, 200, 'application/x-git-upload-pack-result', buf);
    return;
  }
  if (first.startsWith('command=fetch')) {
    const args = parseFetchLines(items);
    const cacheKey = `v2|${repo.objVersion}|${args.wants.join(',')}|${args.depth ?? ''}|${args.haves.join(',')}|${args.shallow.join(',')}`;
    const cached = repo.fetchCache.get(cacheKey);
    if (cached) { sendRaw(res, 200, 'application/x-git-upload-pack-result', cached); return; }
    const { objects, shallow, unshallow } = fetchObjects(repo, args.wants, args.haves, args.depth, args.shallow);
    const pack = writePack(objects);
    // The packfile section is already pkt-line framed by sidebandPack; it must
    // be concatenated as bytes, never wrapped in a second pkt-line (a nested
    // framing makes the client read the inner length prefix as a band byte).
    // Protocol v2 sends no acknowledgments section when the client sent no
    // have lines: a clone reads straight to the packfile section.
    const head: (string | 'delim')[] = args.haves.length > 0 ? ['acknowledgments\n', 'NAK\n', 'delim'] : [];
    if (shallow.length > 0 || unshallow.length > 0) {
      head.push('shallow-info\n');
      for (const s of shallow) head.push(`shallow ${s}\n`);
      for (const u of unshallow) head.push(`unshallow ${u}\n`);
      head.push('delim');
    }
    head.push('packfile\n');
    const buf = Buffer.concat([pktLines(head), sidebandPack(pack), PKT_FLUSH]);
    repo.fetchCache.set(cacheKey, buf);
    sendRaw(res, 200, 'application/x-git-upload-pack-result', buf);
    return;
  }
  sendJson(res, 400, { message: 'unknown upload-pack command' });
}

function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { items } = decodePkts(body);
  const args = parseFetchLines(items);
  const cacheKey = `v0|${repo.objVersion}|${args.wants.join(',')}|${args.depth ?? ''}|${args.haves.join(',')}|${args.shallow.join(',')}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) { sendRaw(res, 200, 'application/x-git-upload-pack-result', cached); return; }
  const { objects, shallow, unshallow } = fetchObjects(repo, args.wants, args.haves, args.depth, args.shallow);
  const pack = writePack(objects);
  const head: string[] = [];
  for (const s of shallow) head.push(`shallow ${s}\n`);
  for (const u of unshallow) head.push(`unshallow ${u}\n`);
  head.push('NAK\n');
  const buf = Buffer.concat([pktLines(head), sidebandPack(pack), PKT_FLUSH]);
  repo.fetchCache.set(cacheKey, buf);
  sendRaw(res, 200, 'application/x-git-upload-pack-result', buf);
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { items, rest } = decodePkts(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const item of items) {
    if (item.kind !== 'data') continue;
    // Parse "<old> <new> <ref>\n" (optional NUL + capabilities after the ref)
    // without a regex or split/join: two indexOf calls, no allocations.
    let line = item.payload.toString('utf8');
    if (line.charCodeAt(line.length - 1) === 10) line = line.slice(0, -1);
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const sp1 = line.indexOf(' ');
    const sp2 = sp1 < 0 ? -1 : line.indexOf(' ', sp1 + 1);
    if (sp1 > 0 && sp2 > sp1 + 1) {
      const oldOid = line.slice(0, sp1);
      const newOid = line.slice(sp1 + 1, sp2);
      if (isOid(oldOid) && isOid(newOid)) {
        commands.push({ oldOid, newOid, ref: line.slice(sp2 + 1) });
      }
    }
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    if (commands.some((c) => c.newOid !== ZERO_OID)) {
      if (rest.length === 0) throw new Error('no packfile in push');
      const incoming = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of incoming) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, obj);
          repo.objVersion++;
        }
      }
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : 'unpack failed';
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (!current || current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        deleteRef(repo, cmd.ref);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (!current) {
      if (cmd.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} unpack failed\n`);
      } else {
        setRef(repo, cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (!isAncestor(repo, current, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    setRef(repo, cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}\n`);
  }
  const reportText = `unpack ${unpackOk ? 'ok' : unpackDetail}\n${reportLines.join('')}`;
  const inner = pktLines(reportText.split('\n').filter((l) => l !== '').map((l) => `${l}\n`));
  sendRaw(res, 200, 'application/x-git-receive-pack-result', band1(inner, true));
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  // segs: [owner, "<repo>.git", ...]
  if (segs.length < 2 || !segs[1].endsWith('.git')) return false;
  const owner = segs[0];
  const name = segs[1].slice(0, -4);
  const tail = segs.slice(2);
  const repo = owner === VIEWER_LOGIN ? findRepo(owner, name) : undefined;

  if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
      else sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v0AdvertisementCached(repo, service));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', v0AdvertisementCached(repo, service));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'POST' && tail.length === 1) {
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const body = await readBody(req);
    if (tail[0] === 'git-upload-pack') {
      try {
        if ((req.headers['git-protocol'] ?? '') === 'version=2') handleUploadPackV2(repo, body, res);
        else handleUploadPackV0(repo, body, res);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
      }
      return true;
    }
    if (tail[0] === 'git-receive-pack') {
      try {
        handleReceivePack(repo, body, res);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4 — a small parser and executor for the documents gh sends
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'obj'; fields: Record<string, GqlValue> };

interface GqlField {
  name: string;
  alias: string;
  args: Record<string, GqlValue>;
  children: GqlField[];
  fragmentType: string | null;
}

interface GqlOperation {
  kind: string;
  name: string | null;
  fields: GqlField[];
}

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (c === '.') {
      if (src[i + 1] === '.' && src[i + 2] === '.') { tokens.push('...'); i += 3; continue; }
      i += 1;
      continue;
    }
    if ('{}()[]:!=$'.includes(c) || c === '@') {
      tokens.push(c);
      i += 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  #toks: string[];
  #pos = 0;
  constructor(src: string) {
    this.#toks = tokenizeGql(src);
  }
  peek(): string | undefined {
    return this.#toks[this.#pos];
  }
  next(): string {
    return this.#toks[this.#pos++];
  }
  expect(tok: string): void {
    if (this.next() !== tok) throw new Error(`expected ${tok}`);
  }
  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.#pos < this.#toks.length) {
      const tok = this.peek()!;
      if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
        const kind = this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipParens();
        const fields = this.parseSelection();
        ops.push({ kind, name, fields });
      } else if (tok === '{') {
        ops.push({ kind: 'query', name: null, fields: this.parseSelection() });
      } else {
        this.next();
      }
    }
    return ops;
  }
  skipParens(): void {
    let depth = 0;
    while (this.#pos < this.#toks.length) {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') { depth -= 1; if (depth === 0) return; }
    }
  }
  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== undefined && this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField(): GqlField {
    let fragmentType: string | null = null;
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      } else {
        // A named fragment spread: skip its name; the fragment itself is not
        // in these documents, so there is nothing to expand.
        this.next();
        return { name: '', alias: '', args: {}, children: [], fragmentType: null };
      }
      const children = this.parseSelection();
      return { name: '', alias: '', args: {}, children, fragmentType };
    }
    let name = this.next();
    let alias = name;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    const children = this.peek() === '{' ? this.parseSelection() : [];
    return { name, alias, args, children, fragmentType };
  }
  parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '$') return { kind: 'var', name: this.next() };
    if (tok === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'obj', fields };
    }
    if (tok.startsWith('"')) return { kind: 'str', value: JSON.parse(tok) as string };
    if (tok === 'true') return { kind: 'bool', value: true };
    if (tok === 'false') return { kind: 'bool', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number(tok) };
    return { kind: 'enum', value: tok };
  }
}

function resolveGqlValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return variables[v.name];
    case 'str': return v.value;
    case 'int': return v.value;
    case 'enum': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((i) => resolveGqlValue(i, variables));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveGqlValue(val, variables);
      return out;
    }
  }
}

function gqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveGqlValue(v, variables);
  return out;
}

function cursorFor(n: number): string {
  return Buffer.from(`issue:${n}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('issue:')) return null;
    const n = Number(text.slice(6));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Field tables for introspection and unknown-field detection.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'url', 'createdAt', 'headRefOid', 'baseRefOid'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'isPrivate'],
  SearchType: [],
  User: ['id', 'login', 'name'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI'];

interface GqlCtx {
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

function selectFields(ctx: GqlCtx, typeName: string, fields: GqlField[], source: (name: string, field: GqlField) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = TYPE_FIELDS[typeName];
  for (const field of fields) {
    if (field.fragmentType !== null) {
      if (field.fragmentType === typeName || typeName === 'Node') {
        Object.assign(out, selectFields(ctx, typeName, field.children, source));
      }
      continue;
    }
    if (field.name === '') continue;
    if (field.name === '__typename') { out[field.alias] = typeName; continue; }
    if (allowed && !allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    out[field.alias] = source(field.name, field);
  }
  return out;
}

function issueObject(ctx: GqlCtx, repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> {
  return selectFields(ctx, 'Issue', fields, (name) => {
    switch (name) {
      case 'id': return issueGid(repo, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': case 'updatedAt': return FIXED_STAMP;
      default: return null;
    }
  });
}

function pullObject(ctx: GqlCtx, repo: Repo, pull: Pull, fields: GqlField[]): Record<string, unknown> {
  return selectFields(ctx, 'PullRequest', fields, (name, field) => {
    switch (name) {
      case 'id': return pullGid(repo, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'mergeable': return pull.state === 'open' ? (mergeConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
      case 'body': return pull.body;
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt': return FIXED_STAMP;
      case 'headRefOid': return pull.headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'files': {
        const args = gqlArgs(field, ctx.variables);
        const first = typeof args.first === 'number' ? args.first : 10;
        return {
          nodes: pull.files.slice(0, first).map((f) => ({ path: f.filename })),
          totalCount: pull.files.length,
        };
      }
      default: return null;
    }
  });
}

function repoObject(ctx: GqlCtx, repo: Repo, fields: GqlField[]): Record<string, unknown> {
  return selectFields(ctx, 'Repository', fields, (name, field) => {
    const args = gqlArgs(field, ctx.variables);
    switch (name) {
      case 'id': return repoGid(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return selectFields(ctx, 'User', field.children, (n) => (n === 'login' ? repo.owner : n === 'id' ? 1000 : null));
      case 'defaultBranchRef': {
        const tip = refTip(repo, repo.defaultBranch);
        if (!tip) return null;
        return { name: repo.defaultBranch };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'isPrivate': return repo.priv;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === args.number);
        if (!issue) return null;
        return issueObject(ctx, repo, issue, field.children);
      }
      case 'issues': {
        let list = [...repo.issues];
        if (Array.isArray(args.states)) {
          const wanted = (args.states as unknown[]).map((s) => String(s).toLowerCase());
          list = list.filter((i) => wanted.includes(i.state));
        }
        const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
        const desc = String(orderBy.direction ?? '').toUpperCase() === 'DESC';
        list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        const afterN = cursorNumber(args.after);
        if (afterN !== null) list = list.filter((i) => i.number > afterN);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const rest = list.slice(first);
        // The item fields live under the `nodes` (or `edges { node }`) child,
        // not directly under the connection: resolving them against the issue
        // type from here would record a spurious unknown-field error.
        const nodesField = field.children.find((c) => c.name === 'nodes');
        const edgesField = field.children.find((c) => c.name === 'edges');
        const edgeNode = edgesField?.children.find((c) => c.name === 'node');
        const itemFields = nodesField?.children ?? edgeNode?.children ?? [];
        const nodes = page.map((i) => issueObject(ctx, repo, i, itemFields));
        const edges = edgesField ? page.map((i) => ({ node: issueObject(ctx, repo, i, itemFields) })) : undefined;
        return {
          nodes,
          ...(edges !== undefined ? { edges } : {}),
          pageInfo: {
            hasNextPage: rest.length > 0,
            endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
          },
          totalCount: list.length,
        };
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
        const nodesField = field.children.find((c) => c.name === 'nodes');
        const itemFields = nodesField?.children ?? [];
        return { nodes: repo.pulls.slice(0, first).map((p) => pullObject(ctx, repo, p, itemFields)) };
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === args.number);
        if (!pull) return null;
        return pullObject(ctx, repo, pull, field.children);
      }
      default: return null;
    }
  });
}

function executeOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: GqlCtx = { errors: [], variables };
  const isMutation = op.kind === 'mutation';
  const data = selectFields(ctx, isMutation ? 'Mutation' : 'Query', op.fields, (name, field) => {
    const args = gqlArgs(field, ctx.variables);
    if (isMutation) {
      const input = isRecord(args.input) ? args.input : {};
      if (name === 'createIssue') {
        const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
        const repo = decoded && decoded.kind === 'R' ? findRepo(...(decoded.key.split('/') as [string, string])) : undefined;
        if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
        const issue = createIssueRecord(repo, str(input.title), str(input.body), []);
        const issueField = field.children.find((c) => c.name === 'issue');
        return { issue: issueObject(ctx, repo, issue, issueField?.children ?? []) };
      }
      if (name === 'closeIssue') {
        const decoded = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
        if (!decoded || decoded.kind !== 'I') { ctx.errors.push({ message: 'issue not found' }); return null; }
        const [owner, rest] = decoded.key.split('/');
        const n = Number(rest.split(':')[1]);
        const repo = findRepo(owner, rest.split(':')[0]);
        const issue = repo?.issues.find((i) => i.number === n);
        if (!repo || !issue) { ctx.errors.push({ message: 'issue not found' }); return null; }
        issue.state = 'closed';
        invalidateIssue(issue);
        const issueField = field.children.find((c) => c.name === 'issue');
        return { issue: issueObject(ctx, repo, issue, issueField?.children ?? []) };
      }
      if (name === 'createPullRequest') {
        const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
        const repo = decoded && decoded.kind === 'R' ? findRepo(...(decoded.key.split('/') as [string, string])) : undefined;
        if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
        const pull = createPullRecord(repo, str(input.title), '', str(input.headRefName), str(input.baseRefName));
        if (!pull) { ctx.errors.push({ message: 'head or base branch does not exist' }); return null; }
        const pullField = field.children.find((c) => c.name === 'pullRequest');
        return { pullRequest: pullObject(ctx, repo, pull, pullField?.children ?? []) };
      }
      if (name === 'mergePullRequest') {
        const decoded = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
        if (!decoded || decoded.kind !== 'P') { ctx.errors.push({ message: 'pull request not found' }); return null; }
        const [owner, rest] = decoded.key.split('/');
        const n = Number(rest.split(':')[1]);
        const repo = findRepo(owner, rest.split(':')[0]);
        const pull = repo?.pulls.find((p) => p.number === n);
        if (!repo || !pull) { ctx.errors.push({ message: 'pull request not found' }); return null; }
        if (pull.state !== 'open' || mergeConflicts(repo, pull)) {
          ctx.errors.push({ message: 'pull request cannot be merged' });
          const pullField = field.children.find((c) => c.name === 'pullRequest');
          return { pullRequest: pullObject(ctx, repo, pull, pullField?.children ?? []) };
        }
        const sha = squashMerge(repo, pull);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = FIXED_STAMP;
        pull.mergeSha = sha;
        const pullField = field.children.find((c) => c.name === 'pullRequest');
        return { pullRequest: pullObject(ctx, repo, pull, pullField?.children ?? []) };
      }
      if (name === 'addComment') {
        const decoded = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
        if (!decoded || decoded.kind !== 'I') { ctx.errors.push({ message: 'subject not found' }); return null; }
        const [owner, rest] = decoded.key.split('/');
        const n = Number(rest.split(':')[1]);
        const repo = findRepo(owner, rest.split(':')[0]);
        const issue = repo?.issues.find((i) => i.number === n);
        if (!repo || !issue) { ctx.errors.push({ message: 'subject not found' }); return null; }
        const comment: Comment = { id: repo.nextComment++, body: str(input.body) };
        issue.comments.push(comment);
        invalidateIssue(issue);
        const edge = field.children.find((c) => c.name === 'commentEdge');
        const nodeField = edge?.children.find((c) => c.name === 'node');
        const nodeOut: Record<string, unknown> = {};
        for (const f of nodeField?.children ?? []) {
          if (f.name === 'id') nodeOut[f.alias] = gid('C', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
          else if (f.name === 'body') nodeOut[f.alias] = comment.body;
          else nodeOut[f.alias] = null;
        }
        return { commentEdge: { node: nodeOut } };
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
      return null;
    }
    switch (name) {
      case 'viewer':
        return selectFields(ctx, 'User', field.children, (n) => (n === 'login' ? VIEWER_LOGIN : n === 'id' ? 1000 : null));
      case 'repository': {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? findRepo(args.owner, args.name) : undefined;
        if (!repo || repo.owner !== VIEWER_LOGIN) return null;
        return repoObject(ctx, repo, field.children);
      }
      case 'node': {
        const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
        if (!decoded || decoded.kind !== 'R') return null;
        const repo = findRepo(...(decoded.key.split('/') as [string, string]));
        if (!repo) return null;
        return repoObject(ctx, repo, field.children);
      }
      case '__type': {
        const typeName = str(args.name);
        const fields = TYPE_FIELDS[typeName] ?? [];
        const out: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'fields') out[child.alias] = fields.map((f) => ({ name: f }));
          else if (child.name === 'enumValues') out[child.alias] = typeName === 'SearchType' ? SEARCH_ENUMS.map((e) => ({ name: e })) : [];
          else if (child.name === 'name') out[child.alias] = typeName;
          else out[child.alias] = null;
        }
        return out;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
        return null;
    }
  });
  return { data, errors: ctx.errors };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!bearerOk(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'a query string is required' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(doc.query).parseDocument();
    } catch {
      return { data: null, errors: [{ message: 'could not parse the query' }] };
    }
    if (ops.length === 0) return { data: null, errors: [{ message: 'no operation in the query' }] };
    let op = ops[0];
    if (typeof doc.operationName === 'string') {
      const named = ops.find((o) => o.name === doc.operationName);
      if (named) op = named;
    }
    const { data, errors } = executeOperation(op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over streamable HTTP, revision 2026-07-28
// ---------------------------------------------------------------------------

const MCP_VERSION = '2026-07-28';
const MCP_LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolText(value: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolFail(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function runMcpTool(name: string, args: Record<string, unknown>): { ok: boolean; value: unknown } {
  const owner = str(args.owner);
  const repoName = str(args.repo);
  switch (name) {
    case 'create_repo': {
      const repoName2 = str(args.name);
      if (repoName2 === '') return { ok: false, value: 'name is required' };
      const existing = findRepo(VIEWER_LOGIN, repoName2);
      const repo = existing ?? createRepoRecord(repoName2, str(args.description), args.private === true);
      return { ok: true, value: repoView(repo) };
    }
    case 'get_repo': {
      const repo = owner === VIEWER_LOGIN ? findRepo(owner, repoName) : undefined;
      if (!repo) return { ok: false, value: `repository ${owner}/${repoName} not found` };
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      const repo = owner === VIEWER_LOGIN ? findRepo(owner, repoName) : undefined;
      if (!repo) return { ok: false, value: `repository ${owner}/${repoName} not found` };
      if (str(args.title) === '') return { ok: false, value: 'title is required' };
      const issue = createIssueRecord(repo, str(args.title), str(args.body), []);
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_issues': {
      const repo = owner === VIEWER_LOGIN ? findRepo(owner, repoName) : undefined;
      if (!repo) return { ok: false, value: `repository ${owner}/${repoName} not found` };
      const state = str(args.state) || 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return { ok: true, value: list.map((i) => issueView(repo, i)) };
    }
    case 'create_pull_request': {
      const repo = owner === VIEWER_LOGIN ? findRepo(owner, repoName) : undefined;
      if (!repo) return { ok: false, value: `repository ${owner}/${repoName} not found` };
      const head = str(args.head);
      const base = str(args.base) || repo.defaultBranch;
      if (!refTip(repo, head) || !refTip(repo, base)) return { ok: false, value: 'head or base branch does not exist' };
      const pull = createPullRecord(repo, str(args.title), str(args.body), head, base);
      if (!pull) return { ok: false, value: 'could not create the pull request' };
      return { ok: true, value: pullView(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = owner === VIEWER_LOGIN ? findRepo(owner, repoName) : undefined;
      if (!repo) return { ok: false, value: `repository ${owner}/${repoName} not found` };
      const n = num(args.pull_number);
      const pull = n === null ? undefined : repo.pulls.find((p) => p.number === n);
      if (!pull) return { ok: false, value: 'pull request not found' };
      if (pull.state !== 'open') return { ok: false, value: 'pull request is already closed' };
      if (mergeConflicts(repo, pull)) return { ok: false, value: 'merge conflict' };
      const sha = squashMerge(repo, pull);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = FIXED_STAMP;
      pull.mergeSha = sha;
      return { ok: true, value: { sha, merged: true, number: pull.number } };
    }
    default:
      return { ok: false, value: `unknown tool ${name}` };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!bearerOk(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let doc: unknown = null;
  let parseFailed = false;
  if (raw.length === 0) parseFailed = true;
  else {
    try {
      doc = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      parseFailed = true;
    }
  }
  if (parseFailed) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (!isRecord(doc)) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const id = doc.id ?? null;
  const method = str(doc.method);
  const params = isRecord(doc.params) ? doc.params : {};

  // A request without an id is a notification: answer 202 with no body.
  if (doc.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [MCP_VERSION, ...MCP_LEGACY],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge.',
      serverInfo: { name: 'forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    }));
    return;
  }
  if (method === 'initialize') {
    const wanted = str(params.protocolVersion);
    const negotiated = wanted === '' ? MCP_LEGACY[0] : ([MCP_VERSION, ...MCP_LEGACY].includes(wanted) ? wanted : MCP_LEGACY[0]);
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    // The same array, built the same way every time, so two calls agree byte
    // for byte.
    sendJson(res, 200, rpcResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = str(params.name);
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      sendJson(res, 200, rpcError(id, -32602, `unknown tool ${toolName}`));
      return;
    }
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) {
      sendJson(res, 200, rpcResult(id, toolFail(`missing required argument(s): ${missing.join(', ')}`)));
      return;
    }
    const outcome = runMcpTool(toolName, args);
    if (!outcome.ok) {
      sendJson(res, 200, rpcResult(id, toolFail(String(outcome.value))));
      return;
    }
    sendJson(res, 200, rpcResult(id, toolText(outcome.value)));
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function createForge(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = urlOf(req);
      const segs = segments(url.pathname);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      // Fast path for the hottest timed route: GET /api/v3/repos/{o}/{r}/issues/{n}
      // (2,000 sequential reads of one issue). Byte-identical to the handleRest
      // branch it bypasses: bearer first, then repo, then the issue; anything
      // with a query string or a non-numeric id falls through untouched.
      if (method === 'GET' && segs.length === 7 && segs[0] === 'api' && segs[1] === 'v3'
        && segs[2] === 'repos' && segs[5] === 'issues' && (req.url ?? '').indexOf('?') < 0
        && /^\d+$/.test(segs[6])) {
        if (!bearerOk(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
        const fastRepo = segs[3] === VIEWER_LOGIN ? findRepo(segs[3], segs[4]) : undefined;
        if (!fastRepo) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const fastIssue = fastRepo.issueByNumber.get(Number(segs[6]));
        if (!fastIssue) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendBuf(res, 200, issueBuf(fastRepo, fastIssue), 'application/json; charset=utf-8');
        return;
      }
      if (url.pathname === '/mcp') {
        await handleMcp(req, res);
        return;
      }
      if (url.pathname === '/api/graphql') {
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
        await handleGraphQL(req, res);
        return;
      }
      if (segs[0] === 'api' && segs[1] === 'v3') {
        const handled = await handleRest(req, res, segs, url.searchParams);
        if (handled) return;
      }
      if (segs.length >= 2 && segs[1].endsWith('.git')) {
        const handled = await handleGit(req, res, segs, url.searchParams);
        if (handled) return;
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      // Anything else is a JSON 404, never HTML.
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      // A body on an unknown route still needs draining before answering.
      await readBody(req);
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        try { res.end(); } catch { /* already closing */ }
      }
    }
  });
}
