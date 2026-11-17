/**
 * Minimal CBOR (RFC 8949) codec for Modal function arguments and results
 * (`DATA_FORMAT_CBOR`): null, booleans, numbers, strings, byte strings,
 * arrays and string-keyed maps. NOT exported from `index.ts`.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

class Out {
  bytes: number[] = [];
  head(major: number, n: number) {
    if (n < 24) this.bytes.push((major << 5) | n);
    else if (n < 0x100) this.bytes.push((major << 5) | 24, n);
    else if (n < 0x10000) this.bytes.push((major << 5) | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000)
      this.bytes.push(
        (major << 5) | 26,
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      );
    else {
      const big = BigInt(n);
      this.bytes.push((major << 5) | 27);
      for (let i = 7; i >= 0; i--) this.bytes.push(Number((big >> BigInt(i * 8)) & 0xffn));
    }
  }
}

const write = (out: Out, value: unknown): void => {
  if (value === null || value === undefined) {
    out.bytes.push(0xf6);
  } else if (value === false) {
    out.bytes.push(0xf4);
  } else if (value === true) {
    out.bytes.push(0xf5);
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      if (value >= 0) out.head(0, value);
      else out.head(1, -1 - value);
    } else {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value);
      out.bytes.push(0xfb, ...new Uint8Array(view.buffer));
    }
  } else if (typeof value === "bigint") {
    write(out, Number(value));
  } else if (typeof value === "string") {
    const bytes = enc.encode(value);
    out.head(3, bytes.length);
    out.bytes.push(...bytes);
  } else if (value instanceof Uint8Array) {
    out.head(2, value.length);
    out.bytes.push(...value);
  } else if (Array.isArray(value)) {
    out.head(4, value.length);
    for (const item of value) write(out, item);
  } else if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    out.head(5, entries.length);
    for (const [key, item] of entries) {
      write(out, key);
      write(out, item);
    }
  } else {
    throw new TypeError(`Can't encode ${typeof value} as CBOR`);
  }
};

/** Encode a value as CBOR. Throws a `TypeError` for functions and symbols. */
export const encodeCbor = (value: unknown): Uint8Array => {
  const out = new Out();
  write(out, value);
  return new Uint8Array(out.bytes);
};

/** Decode CBOR. Throws a `RangeError` on malformed input. */
export const decodeCbor = (bytes: Uint8Array): unknown => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new RangeError("Truncated CBOR");
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return (need(1), bytes[pos++]!);
    if (info === 25) return (need(2), (pos += 2), view.getUint16(pos - 2));
    if (info === 26) return (need(4), (pos += 4), view.getUint32(pos - 4));
    if (info === 27) return (need(8), (pos += 8), Number(view.getBigUint64(pos - 8)));
    throw new RangeError(`Unsupported CBOR length ${info}`);
  };
  const read = (): unknown => {
    need(1);
    const first = bytes[pos++]!;
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        need(n);
        pos += n;
        return bytes.slice(pos - n, pos);
      }
      case 3: {
        const n = length(info);
        need(n);
        pos += n;
        return dec.decode(bytes.subarray(pos - n, pos));
      }
      case 4: {
        const n = length(info);
        return Array.from({ length: n }, read);
      }
      case 5: {
        const n = length(info);
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = read();
          out[String(key)] = read();
        }
        return out;
      }
      case 6:
        length(info);
        return read();
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) {
          need(2);
          pos += 2;
          return view.getFloat16 ? view.getFloat16(pos - 2) : halfToFloat(view.getUint16(pos - 2));
        }
        if (info === 26) return (need(4), (pos += 4), view.getFloat32(pos - 4));
        if (info === 27) return (need(8), (pos += 8), view.getFloat64(pos - 8));
        throw new RangeError(`Unsupported CBOR simple value ${info}`);
      default:
        throw new RangeError(`Unsupported CBOR major type ${major}`);
    }
  };
  return read();
};

const halfToFloat = (h: number): number => {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
};
