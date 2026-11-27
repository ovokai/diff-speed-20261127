// A fast line diff whose patch is byte-identical to makefun-diff 1.0.0's
// patch for the same two texts.
//
// How it works, in outline:
//
//  * Each text is indexed once: for every line, its start offset in the
//    text plus two independent 32-bit hashes of the line's code units.
//    A line runs up to and including its "\n" when it has one, so a line
//    that ends its text with no newline never matches a line that has
//    one. Comparing lines during the search is then a pair of integer
//    compares instead of a walk over the characters.
//  * Two different lines agree on both hashes with probability 2^-64
//    per compared pair. Every kept pair of the finished script is
//    re-checked by direct comparison of the code units, and a failure
//    re-runs the whole diff with exact comparisons, so a hash collision
//    can never change the answer.
//  * The lines both texts share at the start are kept, then the lines
//    both share at the end, of the lines left. Between them runs
//    Myers's greedy search: for d = 0, 1, 2, ... edits and each diagonal
//    k = x - y from -d to d in steps of 2, the furthest point a path of
//    d edits reaches on k is one old line past the furthest (d-1)-point
//    on diagonal k - 1 (a deletion) or one new line past the furthest
//    (d-1)-point on diagonal k + 1 (an insertion), whichever lies
//    further into the old text, and the deletion when both reach the
//    same point; a move past the end of either text is no candidate,
//    no diagonal is pruned, and from that point the path keeps every
//    line equal in both texts as far as it can. The first path to reach
//    the ends of both texts is the script.
//  * The search records, for each depth, the furthest old-line count
//    reached on each diagonal, in one flat integer table shared by all
//    the depths and reused from case to case: row d starts at offset
//    d*(d+5)/2 and holds d+1 entries, one per diagonal k = 2j - d,
//    between two -1 sentinels that stand in for the missing candidates
//    at the row's ends. The script is then walked back from the far
//    corner, using the same choice (and the same tie-break) at every
//    depth, so the walk recovers the path the search found.
//  * The patch is built from the script the way makefun-diff writes
//    it: a header line, hunks of at most 3 kept lines of context, runs
//    at most 6 kept lines apart sharing a hunk, deletions before
//    insertions inside a run, and a "%" line after a line that ends its
//    text with no newline.

const KEEP = 0;
const DEL = 1;
const INS = 2;

/** A text's lines: each line's start offset and two 32-bit hashes. */
function indexText(text) {
  const len = text.length;
  const starts = [];
  if (len > 0) {
    starts.push(0);
    let at = -1;
    while ((at = text.indexOf('\n', at + 1)) !== -1) {
      if (at + 1 >= len) break;
      starts.push(at + 1);
    }
  }
  const count = starts.length;
  const start = new Int32Array(count);
  for (let i = 0; i < count; i++) start[i] = starts[i];
  const h1 = new Uint32Array(count);
  const h2 = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const a = start[i];
    const b = i + 1 < count ? start[i + 1] : len;
    let x = 0x811c9dc5;
    let y = 0x01000193;
    for (let j = a; j < b; j++) {
      const c = text.charCodeAt(j);
      x = (Math.imul(x, 16777619) ^ c) >>> 0;
      y = (Math.imul(y, 31) + c) >>> 0;
    }
    h1[i] = x;
    h2[i] = y;
  }
  return { text, start, h1, h2, count };
}

/** Two lines of two indexed texts, compared code unit by code unit. */
function linesEqual(a, ai, b, bi) {
  const a0 = a.start[ai];
  const a1 = ai + 1 < a.count ? a.start[ai + 1] : a.text.length;
  const b0 = b.start[bi];
  const b1 = bi + 1 < b.count ? b.start[bi + 1] : b.text.length;
  if (a1 - a0 !== b1 - b0) return false;
  const t = a.text;
  const u = b.text;
  for (let k = 0; k < a1 - a0; k++) {
    if (t.charCodeAt(a0 + k) !== u.charCodeAt(b0 + k)) return false;
  }
  return true;
}

// The furthest-point table: one flat Int32Array, reused from case to
// case. Row d starts at offset d*(d+5)/2 and holds d+3 entries: a -1
// sentinel, d+1 entries (one per diagonal k = 2j - d), and a -1
// sentinel, so the deletion candidate of the first diagonal and the
// insertion candidate of the last one read the sentinel and are simply
// invalid. Entry j is the furthest old-line count reached on its
// diagonal after d edits (and its snake), or -1 when no path of d
// edits reaches that diagonal. vCap is the largest depth the table
// currently holds.
let vTable = new Int32Array(0);
let vCap = -1;

/** Grow the table so it holds depths up to `depth`. */
function ensureVTable(depth) {
  if (depth <= vCap) return;
  let cap = vCap < 0 ? 1024 : vCap;
  while (cap < depth) cap *= 2;
  const size = ((cap + 1) * (cap + 6)) / 2;
  const next = new Int32Array(size);
  if (vCap >= 0) next.set(vTable.subarray(0, ((vCap + 1) * (vCap + 6)) / 2));
  vTable = next;
  vCap = cap;
}

/**
 * The edit script of the middle of the two texts, as runs
 * [{ kind, count }] in order, kind KEEP / DEL / INS.
 * The middle is a.h1/h2[aOff .. aOff+n) against b.h1/h2[bOff .. bOff+m).
 * When exact is set, lines are compared by their code units instead of
 * by their hashes (the slow path, used only if the hash run ever fails
 * its verification).
 */
function searchRuns(a, b, aOff, bOff, n, m, exact) {
  const ah1 = a.h1.subarray(aOff, aOff + n);
  const ah2 = a.h2.subarray(aOff, aOff + n);
  const bh1 = b.h1.subarray(bOff, bOff + m);
  const bh2 = b.h2.subarray(bOff, bOff + m);
  const same = exact
    ? (x, y) => linesEqual(a, aOff + x, b, bOff + y)
    : (x, y) => ah1[x] === bh1[y] && ah2[x] === bh2[y];

  ensureVTable(Math.ceil(0.2 * (n > m ? n : m)) + 64);
  // Depth 0: the seed snake from (0,0).
  let x = 0;
  let y = 0;
  while (x < n && y < m && same(x, y)) {
    x++;
    y++;
  }
  vTable[0] = -1;
  vTable[1] = x;
  vTable[2] = -1;
  if (x === n && y === m) return [];

  let depth = -1;
  for (let d = 1; d <= n + m; d++) {
    ensureVTable(d);
    const base = (d * (d + 5)) / 2;
    const prevBase = ((d - 1) * (d + 4)) / 2;
    vTable[base] = -1;
    vTable[base + d + 2] = -1;
    let done = false;
    let rp = prevBase;
    let wp = base + 1;
    let k = -d;
    for (let j = 0; j <= d; j++, k += 2, rp++, wp++) {
      const vd = vTable[rp];
      const vi = vTable[rp + 1];
      const xDel = vd >= 0 && vd < n ? vd + 1 : -1;
      const xIns = vi >= 0 && vi - k - 1 < m ? vi : -1;
      const xx0 = xDel >= xIns ? xDel : xIns;
      if (xx0 < 0) {
        vTable[wp] = -1;
        continue;
      }
      let xx = xx0;
      let yy = xx - k;
      while (xx < n && yy < m && same(xx, yy)) {
        xx++;
        yy++;
      }
      vTable[wp] = xx;
      if (xx === n && yy === m) {
        depth = d;
        done = true;
        break;
      }
    }
    if (done) break;
  }
  if (depth < 0) throw new Error('diff: the search ended without reaching both ends');

  // Walk back from the far corner. At depth d the point (cx, cy) sits on
  // diagonal k = cx - cy; the move into it came from the (d-1)-point on
  // diagonal k - 1 (a deletion) or k + 1 (an insertion), chosen by the
  // same rule the search used, and the lines between the move's landing
  // point and (cx, cy) are the snake the search followed there.
  const rev = [];
  let cx = n;
  let cy = m;
  for (let d = depth; d >= 1; d--) {
    const k = cx - cy;
    const j = (k + d) / 2;
    const prevBase = ((d - 1) * (d + 4)) / 2;
    const vDel = vTable[prevBase + j];
    const vIns = vTable[prevBase + j + 1];
    const delOk = vDel >= 0 && vDel < n;
    const insOk = vIns >= 0 && vIns - k - 1 < m;
    let isDel;
    if (delOk && (!insOk || vDel + 1 >= vIns)) isDel = true;
    else if (insOk) isDel = false;
    else throw new Error('diff: the walk back lost the path');
    let px;
    let py;
    if (isDel) {
      px = vDel;
      py = vDel - (k - 1);
    } else {
      px = vIns;
      py = vIns - (k + 1);
    }
    const mx = isDel ? px + 1 : px;
    const keep = cx - mx;
    if (keep > 0) rev.push({ kind: KEEP, count: keep });
    rev.push({ kind: isDel ? DEL : INS, count: 1 });
    cx = px;
    cy = py;
  }
  if (cx > 0) rev.push({ kind: KEEP, count: cx });

  // Reverse, merging runs of one kind that the walk split apart.
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** Re-check every kept pair of the finished script, exactly. */
function verifyKept(a, b, runs) {
  let o = 0;
  let p = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      for (let i = 0; i < r.count; i++) {
        if (!linesEqual(a, o + i, b, p + i)) return false;
      }
      o += r.count;
      p += r.count;
    } else if (r.kind === DEL) {
      o += r.count;
    } else {
      p += r.count;
    }
  }
  return true;
}

/** One patch line: its op, the line, and "%" on a line of its own when the line had no newline. */
function pushLine(out, op, t, i) {
  const a = t.start[i];
  const b = i + 1 < t.count ? t.start[i + 1] : t.text.length;
  const line = t.text.slice(a, b);
  if (b > a && t.text.charCodeAt(b - 1) === 10) {
    out.push(op, line);
  } else {
    out.push(op, line, '\n%\n');
  }
}

/** makefun-diff 1.0.0's patch of { old, new }, as one string. */
function diffPatch(oldText, newText, exact) {
  const a = indexText(oldText);
  const b = indexText(newText);
  const n = a.count;
  const m = b.count;
  const same = exact
    ? (i, j) => linesEqual(a, i, b, j)
    : (i, j) => a.h1[i] === b.h1[j] && a.h2[i] === b.h2[j];

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && same(prefix, prefix)) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && same(n - 1 - suffix, m - 1 - suffix)) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const mid = searchRuns(a, b, prefix, prefix, n - prefix - suffix, m - prefix - suffix, exact);
  for (const r of mid) runs.push(r);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between
  // two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DEL) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) pushLine(out, '=', a, at);
      for (let i = 0; i < c.dels; i++) pushLine(out, '-', a, c.o + i);
      for (let i = 0; i < c.ins; i++) pushLine(out, '+', b, c.p + i);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushLine(out, '=', a, at);
  }
  return { patch: out.join(''), runs, a, b };
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('diff: the input is { old, new }, two strings');
  }
  const fast = diffPatch(input.old, input.new, false);
  if (verifyKept(fast.a, fast.b, fast.runs)) return fast.patch;
  return diffPatch(input.old, input.new, true).patch;
}
