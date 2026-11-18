import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

/**
 * Offline attenuation of Fly.io API tokens, as `fly tokens attenuate` does.
 *
 * A Fly token is a `FlyV1` header of comma-separated macaroons
 * (`fm2_<base64>`), each a msgpack array `[nonce, location, caveats, tail]`
 * in the format of https://github.com/superfly/macaroon. Its holder can
 * append caveats without asking Fly: each caveat chains
 * `tail = HMAC-SHA256(tail, msgpack([type, body]))`, so the result can only
 * narrow what the token may do. Discharge tokens stay valid, because Fly
 * accepts a discharge bound to any earlier tail of its permission token.
 */

/** Location of the macaroons that carry a token's permissions. */
const PERMISSION_LOCATION = "https://api.fly.io/v1";

const CAVEAT_APPS = 3;
const CAVEAT_VALIDITY_WINDOW = 4;

/** Read, write, create, delete and control (`rwcdC`). */
export const ACTION_ALL = 0x1f;

export type Caveat =
  | {
      readonly type: "Apps";
      /** App internal numeric ID → allowed actions. */
      readonly apps: ReadonlyMap<number, number>;
    }
  | {
      readonly type: "ValidityWindow";
      /** Unix seconds. */
      readonly notBefore: number;
      readonly notAfter: number;
    };

const u32 = (n: number) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// superfly/macaroon encodes with vmihailenco/msgpack's compact ints, so every
// non-negative integer takes its smallest unsigned form.
const uint = (n: number): number[] => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a msgpack uint: ${n}`);
  if (n < 0x80) return [n];
  if (n <= 0xff) return [0xcc, n];
  if (n <= 0xffff) return [0xcd, n >> 8, n & 0xff];
  if (n <= 0xffffffff) return [0xce, ...u32(n)];
  return [0xcf, ...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
};

const arrayHeader = (n: number): number[] => (n < 16 ? [0x90 | n] : [0xdc, n >> 8, n & 0xff]);
const mapHeader = (n: number): number[] => (n < 16 ? [0x80 | n] : [0xde, n >> 8, n & 0xff]);

/** A caveat as it sits in a caveat set: `type, body`. */
const caveatEntry = (caveat: Caveat): number[] => {
  switch (caveat.type) {
    case "Apps": {
      // Fly's ResourceSet sorts its keys, so the encoding is canonical.
      const ids = [...caveat.apps.keys()].sort((a, b) => a - b);
      return [
        ...uint(CAVEAT_APPS),
        ...arrayHeader(1),
        ...mapHeader(ids.length),
        ...ids.flatMap((id) => [...uint(id), ...uint(caveat.apps.get(id)!)]),
      ];
    }
    case "ValidityWindow":
      return [
        ...uint(CAVEAT_VALIDITY_WINDOW),
        ...arrayHeader(2),
        ...uint(caveat.notBefore),
        ...uint(caveat.notAfter),
      ];
  }
};

/** Thrown while parsing; `decodeToken` turns it into `None`. */
class MalformedMacaroon extends Data.TaggedError("Fly.MalformedMacaroon")<{
  readonly message: string;
}> {}

/** The msgpack array header at `at`. */
const arrayAt = (b: Uint8Array, at: number) => {
  const tag = b[at] ?? 0;
  if ((tag & 0xf0) === 0x90) return { length: tag & 0x0f, start: at + 1 };
  if (tag === 0xdc) return { length: ((b[at + 1] ?? 0) << 8) | (b[at + 2] ?? 0), start: at + 3 };
  throw new MalformedMacaroon({ message: "expected an array" });
};

/** The msgpack bin or str at `at`: where its bytes start and end. */
const bytesAt = (b: Uint8Array, at: number) => {
  const tag = b[at] ?? 0;
  if ((tag & 0xe0) === 0xa0) return { start: at + 1, end: at + 1 + (tag & 0x1f) };
  if (tag === 0xc4 || tag === 0xd9) return { start: at + 2, end: at + 2 + (b[at + 1] ?? 0) };
  throw new MalformedMacaroon({ message: "expected bytes" });
};

/**
 * The parts of one macaroon, `[nonce, location, caveats, tail]`, that
 * attenuation reads or rewrites. The caveats are copied as they are, so only
 * their count is read. The tail is always a 32-byte HMAC, so it ends the
 * macaroon.
 */
const parseMacaroon = (b: Uint8Array) => {
  const top = arrayAt(b, 0);
  const nonce = arrayAt(b, top.start);
  const kid = bytesAt(b, nonce.start);
  const rnd = bytesAt(b, kid.end);
  const proof = b[rnd.end];
  if (top.length !== 4 || nonce.length !== 3 || (proof !== 0xc2 && proof !== 0xc3)) {
    throw new MalformedMacaroon({ message: "expected [nonce, location, caveats, tail]" });
  }
  const location = bytesAt(b, rnd.end + 1);
  const caveats = arrayAt(b, location.end);
  const tailAt = b.length - 34;
  if (tailAt < caveats.start || b[tailAt] !== 0xc4 || b[tailAt + 1] !== 32) {
    throw new MalformedMacaroon({ message: "expected a 32-byte tail" });
  }
  return {
    location: new TextDecoder().decode(b.subarray(location.start, location.end)),
    head: b.subarray(0, location.end),
    caveatCount: caveats.length,
    caveats: b.subarray(caveats.start, tailAt),
    tail: b.subarray(tailAt + 2),
    bytes: b,
  };
};

const hmac = (key: Uint8Array, data: Uint8Array) =>
  Effect.promise(async () => {
    const k = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(data)));
  });

const attenuateMacaroon = Effect.fn(function* (
  macaroon: ReturnType<typeof parseMacaroon>,
  caveats: readonly Caveat[],
) {
  const entries = caveats.map(caveatEntry);
  let tail = macaroon.tail;
  for (const entry of entries) {
    tail = yield* hmac(tail, Uint8Array.from([...arrayHeader(2), ...entry]));
  }
  return Uint8Array.from([
    ...macaroon.head,
    ...arrayHeader(macaroon.caveatCount + entries.length * 2),
    ...macaroon.caveats,
    ...entries.flat(),
    0xc4,
    tail.length,
    ...tail,
  ]);
});

/** The token's macaroons; `None` when any part is not one (a legacy token). */
const decodeToken = Option.liftThrowable((header: string) => {
  const parts = header
    .trim()
    .replace(/^(?:(?:FlyV1|Bearer)\s+)+/i, "")
    .split(",");
  return parts.flatMap((part) => {
    const [label, encoded] = part.split("_", 2) as [string, string | undefined];
    // OAuth tokens ride along in some headers and carry no macaroon.
    if (label === "fo1") return [];
    if (encoded === undefined || !["fm1r", "fm1a", "fm2"].includes(label)) {
      throw new MalformedMacaroon({ message: "not a Fly macaroon token" });
    }
    const bytes = Result.getOrThrowWith(
      Base64.decode(encoded),
      () => new MalformedMacaroon({ message: "bad base64" }),
    );
    return [parseMacaroon(bytes)];
  });
});

/**
 * Append `caveats` to every permission macaroon in a Fly token, offline.
 * `None` when the token is not a Fly macaroon token (a legacy token), which
 * can only be used as it is.
 */
export const attenuate = Effect.fn(function* (
  token: Redacted.Redacted<string>,
  caveats: readonly Caveat[],
) {
  const macaroons = token.pipe(Redacted.value, decodeToken, Option.getOrUndefined);
  if (!macaroons?.some((m) => m.location === PERMISSION_LOCATION)) {
    return Option.none<Redacted.Redacted<string>>();
  }
  // flyctl puts the permission macaroons first and their discharges after.
  const permissions = yield* Effect.forEach(
    macaroons.filter((m) => m.location === PERMISSION_LOCATION),
    (m) => attenuateMacaroon(m, caveats),
  );
  const discharges = macaroons.filter((m) => m.location !== PERMISSION_LOCATION);
  const encoded = [...permissions, ...discharges.map((m) => m.bytes)];
  return Option.some(
    Redacted.make(`FlyV1 ${encoded.map((b) => `fm2_${Base64.encode(b)}`).join(",")}`),
  );
});
