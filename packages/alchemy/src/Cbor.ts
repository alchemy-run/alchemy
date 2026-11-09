/**
 * CBOR (RFC 8949), the binary encoding Alchemy's RPC uses on the wire.
 *
 * Values encode in preferred (shortest) form: integers in the fewest bytes,
 * floats at the narrowest of half, single or double precision that holds them
 * exactly. Beyond JSON, CBOR carries `undefined`, `bigint`, raw bytes
 * (`Uint8Array`), typed arrays (RFC 8746), `Date` (tag 1), `Map` (tag 259)
 * and `Set` (tag 258). Decoding also accepts indefinite-length items, so
 * values from any conforming encoder read back.
 *
 * Values JSON would drop are dropped the same way, so switching an encoding
 * from JSON never turns working data into an error: functions and symbols are
 * skipped as object values and become `null` in arrays, and an object with a
 * `toJSON` method encodes what that method returns.
 *
 * @module
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";

/** A value CBOR can't represent: a cycle, or a key that isn't a string. */
export class CborEncodeError extends Data.TaggedError("CborEncodeError")<{
  readonly message: string;
}> {}

/** Bytes that aren't one well-formed CBOR value (or sequence of values). */
export class CborDecodeError extends Data.TaggedError("CborDecodeError")<{
  readonly message: string;
}> {}

const isTagged = <Tag extends string>(value: unknown, tag: Tag): value is { readonly _tag: Tag } =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === tag;

/** The media type of a CBOR body. */
export const contentType = "application/cbor";

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** RFC 8746 tags for typed arrays, little-endian (the host order everywhere JS runs). */
const typedArrayTags: ReadonlyArray<
  readonly [number, abstract new (...args: never) => ArrayBufferView]
> = [
  [68, Uint8ClampedArray],
  [69, Uint16Array],
  [70, Uint32Array],
  [71, BigUint64Array],
  [72, Int8Array],
  [77, Int16Array],
  [78, Int32Array],
  [79, BigInt64Array],
  [85, Float32Array],
  [86, Float64Array],
];

const TAG_DATE_STRING = 0;
const TAG_DATE_EPOCH = 1;
const TAG_BIGNUM_POSITIVE = 2;
const TAG_BIGNUM_NEGATIVE = 3;
const TAG_SET = 258;
const TAG_MAP = 259;

/** A growable output buffer. */
class Writer {
  bytes = new Uint8Array(256);
  view = new DataView(this.bytes.buffer);
  length = 0;

  reserve(n: number) {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  byte(value: number) {
    this.reserve(1);
    this.bytes[this.length++] = value;
  }

  raw(value: Uint8Array) {
    this.reserve(value.length);
    this.bytes.set(value, this.length);
    this.length += value.length;
  }

  /** A major type with its argument in the fewest bytes. */
  head(major: number, argument: number | bigint) {
    const m = major << 5;
    if (typeof argument === "bigint") {
      if (argument <= 0xffff_ffffn) return this.head(major, Number(argument));
      this.reserve(9);
      this.bytes[this.length] = m | 27;
      this.view.setBigUint64(this.length + 1, argument);
      this.length += 9;
      return;
    }
    if (argument < 24) {
      this.byte(m | argument);
    } else if (argument < 0x100) {
      this.reserve(2);
      this.bytes[this.length] = m | 24;
      this.bytes[this.length + 1] = argument;
      this.length += 2;
    } else if (argument < 0x1_0000) {
      this.reserve(3);
      this.bytes[this.length] = m | 25;
      this.view.setUint16(this.length + 1, argument);
      this.length += 3;
    } else if (argument < 0x1_0000_0000) {
      this.reserve(5);
      this.bytes[this.length] = m | 26;
      this.view.setUint32(this.length + 1, argument);
      this.length += 5;
    } else {
      this.reserve(9);
      this.bytes[this.length] = m | 27;
      this.view.setBigUint64(this.length + 1, BigInt(argument));
      this.length += 9;
    }
  }

  result() {
    return this.bytes.slice(0, this.length);
  }
}

/** The half-precision bits for `value`, or `undefined` when it doesn't fit exactly. */
const toHalf = (value: number): number | undefined => {
  if (Number.isNaN(value)) return 0x7e00;
  const f32 = new DataView(new ArrayBuffer(4));
  f32.setFloat32(0, value);
  if (f32.getFloat32(0) !== value) return undefined;
  const bits = f32.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7f_ffff;
  if (exponent === 0xff) return mantissa === 0 ? sign | 0x7c00 : undefined;
  if (exponent === 0 && mantissa === 0) return sign;
  const e = exponent - 127 + 15;
  if (e >= 31) return undefined;
  if (e <= 0) {
    // Subnormal half: the shifted-out bits must all be zero.
    const shift = 14 - e;
    if (shift > 24) return undefined;
    const full = mantissa | 0x80_0000;
    if (full & ((1 << shift) - 1)) return undefined;
    return sign | (full >>> shift);
  }
  if (mantissa & 0x1fff) return undefined;
  return sign | (e << 10) | (mantissa >>> 13);
};

const encodeFloat = (writer: Writer, value: number) => {
  const half = toHalf(value);
  if (half !== undefined) {
    writer.reserve(3);
    writer.bytes[writer.length] = 0xf9;
    writer.view.setUint16(writer.length + 1, half);
    writer.length += 3;
    return;
  }
  if (Math.fround(value) === value) {
    writer.reserve(5);
    writer.bytes[writer.length] = 0xfa;
    writer.view.setFloat32(writer.length + 1, value);
    writer.length += 5;
    return;
  }
  writer.reserve(9);
  writer.bytes[writer.length] = 0xfb;
  writer.view.setFloat64(writer.length + 1, value);
  writer.length += 9;
};

const encodeNumber = (writer: Writer, value: number) => {
  if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
    return value >= 0 ? writer.head(0, value) : writer.head(1, -1 - value);
  }
  encodeFloat(writer, value);
};

// A `bigint` always travels as a bignum (tags 2/3), even when it would fit a
// plain integer, so it decodes as a `bigint` and never turns into a `number`.
const encodeBigInt = (writer: Writer, value: bigint) =>
  value >= 0n
    ? encodeBignum(writer, TAG_BIGNUM_POSITIVE, value)
    : encodeBignum(writer, TAG_BIGNUM_NEGATIVE, -1n - value);

const encodeBignum = (writer: Writer, tag: number, magnitude: bigint) => {
  let hex = magnitude === 0n ? "" : magnitude.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  writer.head(6, tag);
  writer.head(2, bytes.length);
  writer.raw(bytes);
};

/** Whether `value` is skipped (in objects) or `null` (in arrays), as JSON does. */
const isDropped = (value: unknown) => typeof value === "function" || typeof value === "symbol";

const encodeValue = (writer: Writer, value: unknown, seen: Set<object>): void => {
  switch (typeof value) {
    case "undefined":
      return writer.byte(0xf7);
    case "boolean":
      return writer.byte(value ? 0xf5 : 0xf4);
    case "number":
      return encodeNumber(writer, value);
    case "bigint":
      return encodeBigInt(writer, value);
    case "string": {
      const bytes = textEncoder.encode(value);
      writer.head(3, bytes.length);
      return writer.raw(bytes);
    }
    case "function":
    case "symbol":
      return writer.byte(0xf6);
  }
  if (value === null) return writer.byte(0xf6);
  const object = value as object;
  if (object instanceof Uint8Array) {
    writer.head(2, object.length);
    return writer.raw(object);
  }
  if (object instanceof ArrayBuffer) {
    writer.head(2, object.byteLength);
    return writer.raw(new Uint8Array(object));
  }
  if (ArrayBuffer.isView(object)) {
    const entry = typedArrayTags.find(([, type]) => object instanceof type);
    const bytes = new Uint8Array(object.buffer, object.byteOffset, object.byteLength);
    if (entry !== undefined) writer.head(6, entry[0]);
    writer.head(2, bytes.length);
    return writer.raw(bytes);
  }
  if (object instanceof Date) {
    writer.head(6, TAG_DATE_EPOCH);
    const ms = object.getTime();
    return Number.isNaN(ms) ? encodeFloat(writer, Number.NaN) : encodeNumber(writer, ms / 1000);
  }
  if (seen.has(object)) {
    throw new CborEncodeError({ message: "Cannot encode a circular structure as CBOR" });
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      writer.head(4, object.length);
      for (const item of object) encodeValue(writer, isDropped(item) ? null : item, seen);
      return;
    }
    if (object instanceof Map) {
      writer.head(6, TAG_MAP);
      writer.head(5, object.size);
      for (const [key, item] of object) {
        encodeValue(writer, key, seen);
        encodeValue(writer, item, seen);
      }
      return;
    }
    if (object instanceof Set) {
      writer.head(6, TAG_SET);
      writer.head(4, object.size);
      for (const item of object) encodeValue(writer, item, seen);
      return;
    }
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return encodeValue(writer, toJSON.call(object), seen);
    }
    const keys = Object.keys(object).filter(
      (key) => !isDropped((object as Record<string, unknown>)[key]),
    );
    writer.head(5, keys.length);
    for (const key of keys) {
      encodeValue(writer, key, seen);
      encodeValue(writer, (object as Record<string, unknown>)[key], seen);
    }
  } finally {
    seen.delete(object);
  }
};

/**
 * Encode `value` as CBOR. Throws {@link CborEncodeError} for a circular
 * structure; use {@link encode} for the Effect form.
 */
export const encodeUnsafe = (value: unknown): Uint8Array => {
  const writer = new Writer();
  encodeValue(writer, value, new Set());
  return writer.result();
};

/** Encode `value` as CBOR. */
export const encode = (value: unknown): Effect.Effect<Uint8Array, CborEncodeError> =>
  Effect.try({
    try: () => encodeUnsafe(value),
    catch: (cause) =>
      isTagged(cause, "CborEncodeError") ? cause : new CborEncodeError({ message: String(cause) }),
  });

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Thrown internally when the input ends mid-value (sequences wait for more). */
const incomplete: unique symbol = Symbol("cbor/incomplete");

/** Nesting deeper than this is refused, so hostile input can't exhaust the stack. */
const MAX_DEPTH = 512;

const BREAK = Symbol("break");

class Reader {
  offset = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(n: number) {
    if (this.offset + n > this.bytes.length) throw incomplete;
  }

  /** The argument of the head whose additional info is `info`. */
  argument(info: number): number | bigint {
    if (info < 24) return info;
    switch (info) {
      case 24:
        this.need(1);
        return this.bytes[this.offset++]!;
      case 25: {
        this.need(2);
        const value = this.view.getUint16(this.offset);
        this.offset += 2;
        return value;
      }
      case 26: {
        this.need(4);
        const value = this.view.getUint32(this.offset);
        this.offset += 4;
        return value;
      }
      case 27: {
        this.need(8);
        const value = this.view.getBigUint64(this.offset);
        this.offset += 8;
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
    }
    throw new CborDecodeError({ message: `Invalid additional info ${info}` });
  }

  length(info: number): number {
    const value = this.argument(info);
    if (typeof value === "bigint") {
      throw new CborDecodeError({ message: "Length exceeds the maximum safe integer" });
    }
    return value;
  }

  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
}

const halfToNumber = (bits: number) => {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
};

/** Concatenate the chunks of an indefinite-length byte or text string. */
const chunks = (reader: Reader, major: number): Uint8Array => {
  const parts: Uint8Array[] = [];
  for (;;) {
    reader.need(1);
    const initial = reader.bytes[reader.offset++]!;
    if (initial === 0xff) break;
    if (initial >>> 5 !== major || (initial & 0x1f) === 31) {
      throw new CborDecodeError({ message: "Invalid chunk in an indefinite-length string" });
    }
    parts.push(reader.take(reader.length(initial & 0x1f)));
  }
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const bytesToBigInt = (bytes: Uint8Array) => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

const fromTag = (tag: number | bigint, value: unknown): unknown => {
  switch (tag) {
    case TAG_DATE_STRING:
      if (typeof value === "string") return new Date(value);
      break;
    case TAG_DATE_EPOCH:
      if (typeof value === "number") return new Date(Math.round(value * 1000));
      if (typeof value === "bigint") return new Date(Number(value) * 1000);
      break;
    case TAG_BIGNUM_POSITIVE:
      if (value instanceof Uint8Array) return bytesToBigInt(value);
      break;
    case TAG_BIGNUM_NEGATIVE:
      if (value instanceof Uint8Array) return -1n - bytesToBigInt(value);
      break;
    case TAG_SET:
      if (Array.isArray(value)) return new Set(value);
      break;
    case TAG_MAP:
      if (value instanceof Map) return value;
      if (typeof value === "object" && value !== null) return new Map(Object.entries(value));
      break;
    default: {
      const entry = typedArrayTags.find(([code]) => code === tag);
      if (entry !== undefined && value instanceof Uint8Array) {
        const Type = entry[1] as unknown as {
          new (buffer: ArrayBuffer, offset: number, length: number): ArrayBufferView;
          BYTES_PER_ELEMENT: number;
        };
        // A copy, so the view is aligned and outlives the input buffer.
        const copy = value.slice().buffer;
        return new Type(copy, 0, value.byteLength / Type.BYTES_PER_ELEMENT);
      }
      // An unknown tag decodes as the value it wraps.
      return value;
    }
  }
  throw new CborDecodeError({ message: `Invalid content for tag ${String(tag)}` });
};

/**
 * Collect a map's entries as a plain object when every key is a string, and
 * as a `Map` otherwise (CBOR keys can be any value).
 */
const toMapValue = (entries: Array<[unknown, unknown]>): unknown => {
  if (entries.every(([key]) => typeof key === "string")) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (key === "__proto__") {
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[key as string] = value;
      }
    }
    return out;
  }
  return new Map(entries);
};

const decodeItem = (reader: Reader, depth: number): unknown => {
  if (depth > MAX_DEPTH) throw new CborDecodeError({ message: "Nesting too deep" });
  reader.need(1);
  const initial = reader.bytes[reader.offset++]!;
  const major = initial >>> 5;
  const info = initial & 0x1f;
  switch (major) {
    case 0:
      return reader.argument(info);
    case 1: {
      const value = reader.argument(info);
      return typeof value === "bigint" ? -1n - value : -1 - value;
    }
    case 2:
      return info === 31 ? chunks(reader, 2) : reader.take(reader.length(info)).slice();
    case 3: {
      const bytes = info === 31 ? chunks(reader, 3) : reader.take(reader.length(info));
      try {
        return textDecoder.decode(bytes);
      } catch {
        throw new CborDecodeError({ message: "Invalid UTF-8 in a text string" });
      }
    }
    case 4: {
      const items: unknown[] = [];
      if (info === 31) {
        for (;;) {
          const item = decodeItem(reader, depth + 1);
          if (item === BREAK) return items;
          items.push(item);
        }
      }
      const n = reader.length(info);
      // Each item takes at least one byte: refuse lengths the input can't hold.
      reader.need(n);
      for (let i = 0; i < n; i++) items.push(decodeItem(reader, depth + 1));
      return items;
    }
    case 5: {
      const entries: Array<[unknown, unknown]> = [];
      if (info === 31) {
        for (;;) {
          const key = decodeItem(reader, depth + 1);
          if (key === BREAK) return toMapValue(entries);
          entries.push([key, decodeItem(reader, depth + 1)]);
        }
      }
      const n = reader.length(info);
      reader.need(n * 2);
      for (let i = 0; i < n; i++) {
        const key = decodeItem(reader, depth + 1);
        entries.push([key, decodeItem(reader, depth + 1)]);
      }
      return toMapValue(entries);
    }
    case 6: {
      const tag = reader.argument(info);
      return fromTag(tag, decodeItem(reader, depth + 1));
    }
    default: {
      switch (info) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        case 24:
          reader.need(1);
          reader.offset++;
          return undefined;
        case 25: {
          reader.need(2);
          const value = halfToNumber(reader.view.getUint16(reader.offset));
          reader.offset += 2;
          return value;
        }
        case 26: {
          reader.need(4);
          const value = reader.view.getFloat32(reader.offset);
          reader.offset += 4;
          return value;
        }
        case 27: {
          reader.need(8);
          const value = reader.view.getFloat64(reader.offset);
          reader.offset += 8;
          return value;
        }
        case 31:
          if (depth === 0) throw new CborDecodeError({ message: "Unexpected break" });
          return BREAK;
      }
      // Unassigned simple values carry no JavaScript meaning.
      if (info < 20) return undefined;
      throw new CborDecodeError({ message: `Invalid simple value ${info}` });
    }
  }
};

const decodeOne = (reader: Reader): unknown => {
  const value = decodeItem(reader, 0);
  if (value === BREAK) throw new CborDecodeError({ message: "Unexpected break" });
  return value;
};

/**
 * Decode exactly one CBOR value. Throws {@link CborDecodeError} on malformed
 * input, truncation or trailing bytes; use {@link decode} for the Effect form.
 */
export const decodeUnsafe = (bytes: Uint8Array): unknown => {
  const reader = new Reader(bytes);
  let value: unknown;
  try {
    value = decodeOne(reader);
  } catch (cause) {
    if (cause === incomplete) {
      throw new CborDecodeError({ message: "Unexpected end of CBOR input" });
    }
    throw cause;
  }
  if (reader.offset !== bytes.length) {
    throw new CborDecodeError({ message: "Unexpected bytes after the CBOR value" });
  }
  return value;
};

/** Decode exactly one CBOR value. */
export const decode = (bytes: Uint8Array): Effect.Effect<unknown, CborDecodeError> =>
  Effect.try({
    try: () => decodeUnsafe(bytes),
    catch: (cause) =>
      isTagged(cause, "CborDecodeError") ? cause : new CborDecodeError({ message: String(cause) }),
  });

/**
 * An incremental decoder for a CBOR sequence (RFC 8742: values written back
 * to back), for streamed bodies. `push` takes the next chunk and returns
 * every value it completed; a value split across chunks waits for the rest.
 * `end` throws {@link CborDecodeError} when the input stopped mid-value.
 */
export const makeSequenceDecoder = () => {
  let buffer = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): ReadonlyArray<unknown> {
      if (buffer.length === 0) {
        buffer = chunk;
      } else {
        const next = new Uint8Array(buffer.length + chunk.length);
        next.set(buffer);
        next.set(chunk, buffer.length);
        buffer = next;
      }
      const values: unknown[] = [];
      const reader = new Reader(buffer);
      for (;;) {
        const start = reader.offset;
        if (start === buffer.length) break;
        try {
          values.push(decodeOne(reader));
        } catch (cause) {
          if (cause === incomplete) {
            reader.offset = start;
            break;
          }
          throw cause;
        }
      }
      buffer = buffer.subarray(reader.offset);
      return values;
    },
    end() {
      if (buffer.length > 0) {
        throw new CborDecodeError({ message: "Unexpected end of a CBOR sequence" });
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Effect RPC serialization
// ---------------------------------------------------------------------------

/**
 * Effect RPC serialization over CBOR: every protocol message is one CBOR
 * value, and a stream of messages is a CBOR sequence, so message framing is
 * built in. Payloads go through each schema's JSON codec, as
 * `RpcSerialization.json` does, so a schema behaves the same under either
 * serialization; CBOR only changes the bytes on the wire.
 */
export const rpcSerialization: RpcSerialization.RpcSerialization["Service"] =
  RpcSerialization.RpcSerialization.of({
    contentType,
    includesFraming: true,
    codecFor: Schema.toCodecJson,
    makeUnsafe: () => {
      const sequence = makeSequenceDecoder();
      return {
        decode: (data) => sequence.push(typeof data === "string" ? textEncoder.encode(data) : data),
        encode: (message) => encodeUnsafe(message),
      };
    },
  });

/**
 * Provide {@link rpcSerialization} as Effect RPC's `RpcSerialization`.
 *
 * **Example:** Effect RPC over CBOR
 * ```ts
 * const protocol = RpcClient.layerProtocolHttp({ url }).pipe(
 *   Layer.provide(Cbor.layerRpcSerialization),
 * );
 * ```
 */
export const layerRpcSerialization: Layer.Layer<RpcSerialization.RpcSerialization> = Layer.succeed(
  RpcSerialization.RpcSerialization,
  rpcSerialization,
);
