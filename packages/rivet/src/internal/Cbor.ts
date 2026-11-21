/**
 * A CBOR encoder for plain data (RFC 8949): what RivetKit's gateway reads an
 * actor's create input as (`rvt-input`). Strings, numbers and bigints, booleans,
 * `null`, byte arrays, arrays and string-keyed objects; `undefined` object
 * members are left out, as JSON leaves them out.
 *
 * @internal
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const head = (out: number[], major: number, length: number) => {
  const type = major << 5;
  if (length < 24) out.push(type | length);
  else if (length < 0x100) out.push(type | 24, length);
  else if (length < 0x10000) out.push(type | 25, length >> 8, length & 0xff);
  else if (length < 0x100000000) {
    out.push(type | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff);
    out.push(length & 0xff);
  } else {
    const high = Math.floor(length / 0x100000000);
    const low = length >>> 0;
    out.push(type | 27);
    for (const part of [high, low]) {
      out.push((part >>> 24) & 0xff, (part >>> 16) & 0xff, (part >>> 8) & 0xff, part & 0xff);
    }
  }
};

const encodeInto = (out: number[], value: unknown): void => {
  if (value === null || value === undefined) {
    out.push(0xf6);
  } else if (value === false) {
    out.push(0xf4);
  } else if (value === true) {
    out.push(0xf5);
  } else if (typeof value === "bigint") {
    encodeInto(out, Number(value));
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      if (value >= 0) head(out, 0, value);
      else head(out, 1, -1 - value);
    } else {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value);
      out.push(0xfb, ...bytes);
    }
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    head(out, 3, bytes.length);
    for (const byte of bytes) out.push(byte);
  } else if (value instanceof Uint8Array) {
    head(out, 2, value.length);
    for (const byte of value) out.push(byte);
  } else if (Array.isArray(value)) {
    head(out, 4, value.length);
    for (const item of value) encodeInto(out, item);
  } else if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined);
    head(out, 5, entries.length);
    for (const [key, member] of entries) {
      encodeInto(out, key);
      encodeInto(out, member);
    }
  } else {
    // A function or symbol: not plain data. Encode it as null
    // rather than fail, as JSON drops what it can't represent.
    out.push(0xf6);
  }
};

/** Encode plain data as CBOR. */
export const encodeCbor = (value: unknown): Uint8Array => {
  const out: number[] = [];
  encodeInto(out, value);
  return Uint8Array.from(out);
};

/** CBOR the decoder can't read: truncated, or a type plain data doesn't use. */
export class CborDecodeError extends Data.TaggedError("Rivet.CborDecodeError")<{
  readonly message: string;
}> {}

/** Where the decoder stopped, raised while it recurses and caught by {@link decodeCbor}. */
class Malformed {
  constructor(readonly message: string) {}
}

/**
 * Decode CBOR into plain data: byte strings as `Uint8Array`, integers past
 * 2^53 as `bigint`, and tags 2 and 3 (bignums) as `bigint`.
 */
export const decodeCbor = (bytes: Uint8Array): Effect.Effect<unknown, CborDecodeError> =>
  Effect.try({
    try: () => decodeUnsafe(bytes),
    catch: (cause) =>
      new CborDecodeError({
        message: cause instanceof Malformed ? cause.message : `invalid CBOR: ${String(cause)}`,
      }),
  });

const decodeUnsafe = (bytes: Uint8Array): unknown => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Malformed("CBOR ended early");
  };
  const length = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) return (need(1), bytes[at++]!);
    if (info === 25) return (need(2), (at += 2), view.getUint16(at - 2));
    if (info === 26) return (need(4), (at += 4), view.getUint32(at - 4));
    if (info === 27) {
      need(8);
      const value = view.getBigUint64(at);
      at += 8;
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    throw new Malformed(`unsupported CBOR length ${info}`);
  };
  const size = (info: number) => {
    const n = length(info);
    if (typeof n === "bigint") throw new Malformed("CBOR item too large");
    return n;
  };
  const item = (): unknown => {
    need(1);
    const initial = bytes[at++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return length(info);
      case 1: {
        const n = length(info);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2: {
        const n = size(info);
        need(n);
        at += n;
        return bytes.slice(at - n, at);
      }
      case 3: {
        const n = size(info);
        need(n);
        at += n;
        return new TextDecoder().decode(bytes.subarray(at - n, at));
      }
      case 4: {
        const n = size(info);
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(item());
        return out;
      }
      case 5: {
        const n = size(info);
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = item();
          out[String(key)] = item();
        }
        return out;
      }
      case 6: {
        const tag = length(info);
        const value = item();
        if ((tag === 2 || tag === 3) && value instanceof Uint8Array) {
          let n = 0n;
          for (const byte of value) n = (n << 8n) | BigInt(byte);
          return tag === 2 ? n : -1n - n;
        }
        return value;
      }
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) {
          need(2);
          const half = view.getUint16(at);
          at += 2;
          const exponent = (half >> 10) & 0x1f;
          const fraction = half & 0x3ff;
          const sign = half & 0x8000 ? -1 : 1;
          if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
          if (exponent === 31) return fraction ? NaN : sign * Infinity;
          return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
        }
        if (info === 26) return (need(4), (at += 4), view.getFloat32(at - 4));
        if (info === 27) return (need(8), (at += 8), view.getFloat64(at - 8));
        throw new Malformed(`unsupported CBOR simple value ${info}`);
    }
  };
  return item();
};
