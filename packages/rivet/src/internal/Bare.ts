/**
 * RivetKit's `bare` encoding of an HTTP action, the encoding its own client
 * sends: a little-endian u16 protocol version, then a BARE struct. A request
 * is `{ args: data }` and a response `{ output: data }`, each `data` the CBOR
 * of the arguments or the result. An error is `{ group, code, message, … }`.
 *
 * Rivet Services' JSON and CBOR encodings drop the bytes an agentOS action
 * returns (`{ output: null }`), so agentOS calls go over this one.
 *
 * @internal
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { decodeCbor, encodeCbor } from "./Cbor.ts";

/** The protocol version RivetKit 3's HTTP actions speak. */
const VERSION = 4;

const uvarint = (n: number) => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};

/** A `bare` body that isn't the shape RivetKit sends. */
export class BareDecodeError extends Data.TaggedError("Rivet.BareDecodeError")<{
  readonly message: string;
}> {}

/** Read BARE values from `bytes`, after the version. */
const reader = (bytes: Uint8Array) => {
  let at = 2;
  const varint = Effect.suspend(() => {
    let value = 0;
    let scale = 1;
    while (at < bytes.length) {
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return Effect.succeed(value);
      scale *= 0x80;
    }
    return Effect.fail(new BareDecodeError({ message: "body ended inside a length" }));
  });
  const data = Effect.flatMap(varint, (length) =>
    at + length > bytes.length
      ? Effect.fail(new BareDecodeError({ message: "body ended inside a value" }))
      : Effect.sync(() => {
          at += length;
          return bytes.subarray(at - length, at);
        }),
  );
  const string = Effect.map(data, (value) => new TextDecoder().decode(value));
  return { data, string };
};

/** An action's request body: its arguments. */
export const encodeActionRequest = (args: ReadonlyArray<unknown>): Uint8Array => {
  const payload = encodeCbor(args);
  return Uint8Array.from([VERSION & 0xff, VERSION >> 8, ...uvarint(payload.length), ...payload]);
};

/** An action's response body: its result. */
export const decodeActionResponse = (bytes: Uint8Array) =>
  bytes.length < 2
    ? Effect.fail(new BareDecodeError({ message: "body too short for a version" }))
    : Effect.flatMap(reader(bytes).data, decodeCbor);

/** An action's error body: the group, code and message RivetKit reports. */
export const decodeActionError = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    if (bytes.length < 2) {
      return yield* new BareDecodeError({ message: "body too short for a version" });
    }
    const read = reader(bytes);
    return {
      group: yield* read.string,
      code: yield* read.string,
      message: yield* read.string,
    };
  });
