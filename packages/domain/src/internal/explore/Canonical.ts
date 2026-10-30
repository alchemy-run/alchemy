/**
 * The canonical encoding of a search state and its 128-bit digest.
 *
 * The encoding is the WHOLE value with object keys sorted. It accepts plain JSON only: a Date,
 * Map, class instance, BigInt, non-finite number or cycle is an engine error,
 * because a JSON clone would silently change it.
 */
import { EngineFault } from "./Errors.ts";

const isPlain = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const fast = (v: unknown, depth: number): string => {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw FAIL;
      return "" + v;
    case "boolean":
      return v ? "true" : "false";
    case "object": {
      if (depth > 256) throw FAIL;
      if (Array.isArray(v)) {
        let out = "[";
        for (let i = 0; i < v.length; i++) {
          const x = v[i];
          if (x === undefined) throw FAIL;
          out += (i > 0 ? "," : "") + fast(x, depth + 1);
        }
        return out + "]";
      }
      if (!isPlain(v)) throw FAIL;
      const keys = Object.keys(v);
      if (keys.length > 1) keys.sort();
      let out = "{";
      let first = true;
      for (const k of keys) {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined) continue;
        out += (first ? "" : ",") + JSON.stringify(k) + ":" + fast(x, depth + 1);
        first = false;
      }
      return out + "}";
    }
    default:
      throw FAIL;
  }
};
const FAIL = new Error("non-json");

/** The slow path: find where a value stops being plain JSON, for the error. */
const explain = (value: unknown, where: string): EngineFault => {
  const seen = new Set<object>();
  const go = (v: unknown, path: string): string | undefined => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return undefined;
    if (typeof v === "number")
      return Number.isFinite(v) ? undefined : `${path}: non-finite number ${v}`;
    if (typeof v !== "object") return `${path}: a ${typeof v} value`;
    if (seen.has(v)) return `${path}: a cycle`;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (v[i] === undefined) return `${path}[${i}]: undefined in an array`;
        const m = go(v[i], `${path}[${i}]`);
        if (m) return m;
      }
    } else {
      if (!isPlain(v))
        return `${path}: a ${(v as object).constructor?.name ?? "non-plain"} object (plain JSON only)`;
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        const m = go(x, `${path}.${k}`);
        if (m) return m;
      }
    }
    seen.delete(v);
    return undefined;
  };
  return new EngineFault("NonJsonState", `${where}${go(value, "") ?? ": too deep (a cycle?)"}`);
};

export const canonical = (value: unknown, where = "state"): string => {
  try {
    return fast(value, 0);
  } catch (e) {
    if (e === FAIL || e instanceof RangeError) throw explain(value, where);
    throw e;
  }
};

// ─────────────────────────────────────────────────────────── Digest ──

/** A 128-bit digest as four unsigned 32-bit words. */
export type Digest = readonly [number, number, number, number];

/** The identity algorithm, with a version: a change here changes every hash. */
export const DIGEST_ALGORITHM = "sha256-128/1";

const K = new Uint32Array(64);
{
  const fractional = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  let n = 0;
  for (let c = 2; n < 64; c++) {
    let prime = true;
    for (let d = 2; d * d <= c; d++) if (c % d === 0) prime = false;
    if (prime) K[n++] = fractional(Math.cbrt(c));
  }
}
const encoder = new TextEncoder();
const W = new Uint32Array(64);

/** SHA-256 of the UTF-8 text, first 128 bits: the same bytes give the same id on every runtime. */
export const digest = (s: string): Digest => {
  const text = encoder.encode(s);
  const size = (((text.length + 8) >>> 6) + 1) * 64;
  const m = new Uint8Array(size);
  m.set(text);
  m[text.length] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(size - 8, Math.floor((text.length * 8) / 2 ** 32));
  view.setUint32(size - 4, (text.length * 8) >>> 0);
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  for (let o = 0; o < size; o += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(o + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15]!,
        b = W[t - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let t = 0; t < 64; t++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[t]! + W[t]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0 >>> 0, h1 >>> 0, h2 >>> 0, h3 >>> 0];
};

export const digestHex = (d: Digest) => d.map((x) => x.toString(16).padStart(8, "0")).join("");

/** P(any collision) for n states, if the digest behaves as a random 128-bit value: an assumption, not a measurement. */
export const collisionBound = (n: number) => (n * n) / 2 ** 129;

// ────────────────────────────────────────────────────────── Visited ──

/** An open-addressing set of 128-bit digests in a typed array: 16 bytes a state. */
export class DigestTable {
  private words: Uint32Array;
  private cap: number;
  size = 0;

  constructor(initial = 1 << 16) {
    this.cap = initial;
    this.words = new Uint32Array(initial * 4);
  }

  /** Insert `d`; false when it was there already. */
  add(d: Digest): boolean {
    if ((this.size + 1) * 10 > this.cap * 6) this.grow();
    let w0 = d[0],
      w1 = d[1],
      w2 = d[2],
      w3 = d[3];
    if ((w0 | w1 | w2 | w3) === 0) w0 = 1;
    const mask = this.cap - 1;
    let i = (w0 ^ Math.imul(w1, 0x9e3779b1)) & mask;
    for (;;) {
      const o = i * 4;
      const a = this.words[o]!,
        b = this.words[o + 1]!,
        c = this.words[o + 2]!,
        e = this.words[o + 3]!;
      if ((a | b | c | e) === 0) {
        this.words[o] = w0;
        this.words[o + 1] = w1;
        this.words[o + 2] = w2;
        this.words[o + 3] = w3;
        this.size++;
        return true;
      }
      if (a === w0 && b === w1 && c === w2 && e === w3) return false;
      i = (i + 1) & mask;
    }
  }

  get bytes() {
    return this.words.byteLength;
  }

  private grow() {
    const old = this.words;
    const oldCap = this.cap;
    this.cap *= 2;
    this.words = new Uint32Array(this.cap * 4);
    this.size = 0;
    for (let i = 0; i < oldCap; i++) {
      const o = i * 4;
      if ((old[o]! | old[o + 1]! | old[o + 2]! | old[o + 3]!) === 0) continue;
      this.add([old[o]!, old[o + 1]!, old[o + 2]!, old[o + 3]!]);
    }
  }
}

/**
 * The visited set. `digest`: the 128-bit table (the report states the
 * collision bound). `exact`: the canonical strings themselves, and every
 * digest match whose strings differ is counted as a collision.
 */
export class Visited {
  readonly mode: "digest" | "exact";
  private readonly table = new DigestTable();
  private readonly exact: Set<string> | undefined;
  collisions = 0;

  constructor(mode: "digest" | "exact") {
    this.mode = mode;
    this.exact = mode === "exact" ? new Set() : undefined;
  }

  /** Insert a state; false when it was seen before. */
  add(d: Digest, text: string | undefined): boolean {
    if (!this.exact) return this.table.add(d);
    const seen = this.exact.has(text!);
    const fresh = this.table.add(d);
    if (seen) return false;
    if (!fresh) this.collisions++;
    this.exact.add(text!);
    return true;
  }

  get size() {
    return this.exact ? this.exact.size : this.table.size;
  }

  get bytes() {
    return this.table.bytes;
  }
}
