/**
 * A CBOR encoder for plain data (RFC 8949): what RivetKit's gateway reads an
 * actor's create input as (`rvt-input`). Strings, numbers and bigints, booleans,
 * `null`, byte arrays, arrays and string-keyed objects; `undefined` object
 * members are left out, as JSON leaves them out.
 *
 * @internal
 */

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
