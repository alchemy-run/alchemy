import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpEffect from "effect/http/HttpEffect";
import * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Cbor from "@/Cbor";

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// RFC 8949 Appendix A: every example, decoded. `encodes: true` marks the ones
// whose JavaScript value has a single CBOR form, so encoding must reproduce
// the exact bytes (a JS `1.0` is the integer 1, so the float examples only
// decode).
const vectors: ReadonlyArray<{ hex: string; value: unknown; encodes?: boolean }> = [
  { hex: "00", value: 0, encodes: true },
  { hex: "01", value: 1, encodes: true },
  { hex: "0a", value: 10, encodes: true },
  { hex: "17", value: 23, encodes: true },
  { hex: "1818", value: 24, encodes: true },
  { hex: "1819", value: 25, encodes: true },
  { hex: "1864", value: 100, encodes: true },
  { hex: "1903e8", value: 1000, encodes: true },
  { hex: "1a000f4240", value: 1000000, encodes: true },
  { hex: "1b000000e8d4a51000", value: 1000000000000, encodes: true },
  { hex: "1bffffffffffffffff", value: 18446744073709551615n },
  { hex: "c249010000000000000000", value: 18446744073709551616n, encodes: true },
  { hex: "3bffffffffffffffff", value: -18446744073709551616n },
  { hex: "c349010000000000000000", value: -18446744073709551617n, encodes: true },
  { hex: "20", value: -1, encodes: true },
  { hex: "29", value: -10, encodes: true },
  { hex: "3863", value: -100, encodes: true },
  { hex: "3903e7", value: -1000, encodes: true },
  { hex: "f90000", value: 0 },
  { hex: "f98000", value: -0, encodes: true },
  { hex: "f93c00", value: 1 },
  { hex: "fb3ff199999999999a", value: 1.1, encodes: true },
  { hex: "f93e00", value: 1.5, encodes: true },
  { hex: "f97bff", value: 65504 },
  { hex: "fa47c35000", value: 100000 },
  { hex: "fa7f7fffff", value: 3.4028234663852886e38, encodes: true },
  { hex: "fb7e37e43c8800759c", value: 1.0e300, encodes: true },
  { hex: "f90001", value: 5.960464477539063e-8, encodes: true },
  { hex: "f90400", value: 0.00006103515625, encodes: true },
  { hex: "f9c400", value: -4 },
  { hex: "fbc010666666666666", value: -4.1, encodes: true },
  { hex: "f97c00", value: Number.POSITIVE_INFINITY, encodes: true },
  { hex: "f97e00", value: Number.NaN, encodes: true },
  { hex: "f9fc00", value: Number.NEGATIVE_INFINITY, encodes: true },
  { hex: "fa7f800000", value: Number.POSITIVE_INFINITY },
  { hex: "fa7fc00000", value: Number.NaN },
  { hex: "faff800000", value: Number.NEGATIVE_INFINITY },
  { hex: "fb7ff0000000000000", value: Number.POSITIVE_INFINITY },
  { hex: "fb7ff8000000000000", value: Number.NaN },
  { hex: "fbfff0000000000000", value: Number.NEGATIVE_INFINITY },
  { hex: "f4", value: false, encodes: true },
  { hex: "f5", value: true, encodes: true },
  { hex: "f6", value: null, encodes: true },
  { hex: "f7", value: undefined, encodes: true },
  { hex: "f0", value: undefined },
  { hex: "f8ff", value: undefined },
  { hex: "c074323031332d30332d32315432303a30343a30305a", value: new Date("2013-03-21T20:04:00Z") },
  { hex: "c11a514b67b0", value: new Date(1363896240_000), encodes: true },
  { hex: "c1fb41d452d9ec200000", value: new Date(1363896240_500), encodes: true },
  { hex: "d74401020304", value: hex("01020304") },
  { hex: "d818456449455446", value: hex("6449455446") },
  { hex: "d82076687474703a2f2f7777772e6578616d706c652e636f6d", value: "http://www.example.com" },
  { hex: "40", value: new Uint8Array(0), encodes: true },
  { hex: "4401020304", value: hex("01020304"), encodes: true },
  { hex: "60", value: "", encodes: true },
  { hex: "6161", value: "a", encodes: true },
  { hex: "6449455446", value: "IETF", encodes: true },
  { hex: "62225c", value: '"\\', encodes: true },
  { hex: "62c3bc", value: "ü", encodes: true },
  { hex: "63e6b0b4", value: "水", encodes: true },
  { hex: "64f0908591", value: "\u{10151}", encodes: true },
  { hex: "80", value: [], encodes: true },
  { hex: "83010203", value: [1, 2, 3], encodes: true },
  { hex: "8301820203820405", value: [1, [2, 3], [4, 5]], encodes: true },
  {
    hex: "98190102030405060708090a0b0c0d0e0f101112131415161718181819",
    value: Array.from({ length: 25 }, (_, i) => i + 1),
    encodes: true,
  },
  { hex: "a0", value: {}, encodes: true },
  {
    hex: "a201020304",
    value: new Map([
      [1, 2],
      [3, 4],
    ]),
  },
  { hex: "a26161016162820203", value: { a: 1, b: [2, 3] }, encodes: true },
  { hex: "826161a161626163", value: ["a", { b: "c" }], encodes: true },
  {
    hex: "a56161614161626142616361436164614461656145",
    value: { a: "A", b: "B", c: "C", d: "D", e: "E" },
    encodes: true,
  },
  { hex: "5f42010243030405ff", value: hex("0102030405") },
  { hex: "7f657374726561646d696e67ff", value: "streaming" },
  { hex: "9fff", value: [] },
  { hex: "9f018202039f0405ffff", value: [1, [2, 3], [4, 5]] },
  { hex: "9f01820203820405ff", value: [1, [2, 3], [4, 5]] },
  { hex: "83018202039f0405ff", value: [1, [2, 3], [4, 5]] },
  { hex: "83019f0203ff820405", value: [1, [2, 3], [4, 5]] },
  {
    hex: "9f0102030405060708090a0b0c0d0e0f101112131415161718181819ff",
    value: Array.from({ length: 25 }, (_, i) => i + 1),
  },
  { hex: "bf61610161629f0203ffff", value: { a: 1, b: [2, 3] } },
  { hex: "826161bf61626163ff", value: ["a", { b: "c" }] },
  { hex: "bf6346756ef563416d7421ff", value: { Fun: true, Amt: -2 } },
];

const roundTrip = (value: unknown) => Cbor.decodeUnsafe(Cbor.encodeUnsafe(value));

describe("Cbor", { tags: ["unit", "local"] }, () => {
  describe("RFC 8949 Appendix A", () => {
    for (const vector of vectors) {
      it(`decodes ${vector.hex}`, () => {
        expect(Cbor.decodeUnsafe(hex(vector.hex))).toEqual(vector.value);
      });
      if (vector.encodes) {
        it(`encodes ${vector.hex}`, () => {
          expect(toHex(Cbor.encodeUnsafe(vector.value))).toBe(vector.hex);
        });
      }
    }
  });

  describe("JavaScript values round-trip with their types", () => {
    it("bigint stays a bigint, at every size", () => {
      for (const value of [0n, 1n, -1n, 255n, 2n ** 64n, -(2n ** 70n)]) {
        const back = roundTrip(value);
        expect(typeof back).toBe("bigint");
        expect(back).toBe(value);
      }
    });

    it("numbers keep their exact value", () => {
      for (const value of [0, -0, 0.1, 1e-310, 2 ** 53 + 2, -(2 ** 60), Number.MAX_VALUE, 65505]) {
        expect(Object.is(roundTrip(value), value)).toBe(true);
      }
    });

    it("undefined survives inside objects and arrays", () => {
      expect(roundTrip({ a: undefined, b: [undefined] })).toEqual({ a: undefined, b: [undefined] });
      expect("a" in (roundTrip({ a: undefined }) as object)).toBe(true);
    });

    it("bytes, typed arrays, dates, maps and sets", () => {
      const value = {
        bytes: new Uint8Array([0, 255, 7]),
        u16: new Uint16Array([1, 65535]),
        i32: new Int32Array([-1, 2 ** 31 - 1]),
        f64: new Float64Array([Math.PI, -0]),
        big: new BigInt64Array([-5n, 2n ** 62n]),
        clamped: new Uint8ClampedArray([1, 2]),
        when: new Date("2026-11-09T12:34:56.789Z"),
        map: new Map<unknown, unknown>([
          ["k", 1],
          [2, "two"],
        ]),
        set: new Set(["x", 1]),
      };
      const back = roundTrip(value) as typeof value;
      expect(back).toEqual(value);
      expect(back.u16).toBeInstanceOf(Uint16Array);
      expect(back.big).toBeInstanceOf(BigInt64Array);
      expect(back.clamped).toBeInstanceOf(Uint8ClampedArray);
      expect(back.when.getTime()).toBe(value.when.getTime());
      expect(back.map).toBeInstanceOf(Map);
      expect(back.set).toBeInstanceOf(Set);
    });

    it("a view into a larger buffer encodes only its own bytes", () => {
      const buffer = new Uint8Array([9, 9, 1, 2, 3, 9]);
      expect(roundTrip(buffer.subarray(2, 5))).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("an invalid date stays invalid", () => {
      expect(Number.isNaN((roundTrip(new Date(Number.NaN)) as Date).getTime())).toBe(true);
    });

    it("a __proto__ key is an own property, not a prototype", () => {
      const back = Cbor.decodeUnsafe(hex("a1695f5f70726f746f5f5f01")) as Record<string, unknown>;
      expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
      expect(Object.keys(back)).toEqual(["__proto__"]);
    });

    it("a large value round-trips", () => {
      const value = {
        rows: Array.from({ length: 2000 }, (_, i) => ({
          id: i,
          name: `row-${i}`,
          ok: i % 2 === 0,
        })),
        blob: new Uint8Array(1 << 20).map((_, i) => i % 251),
      };
      expect(roundTrip(value)).toEqual(value);
    });
  });

  describe("matches JSON where JSON drops a value", () => {
    it("functions and symbols are skipped in objects and null in arrays", () => {
      const value = { keep: 1, fn: () => 1, sym: Symbol("s"), list: [() => 1, Symbol("t"), 2] };
      expect(roundTrip(value)).toEqual(JSON.parse(JSON.stringify(value)));
    });

    it("toJSON is used, as JSON.stringify does", () => {
      const value = { id: { toJSON: () => "custom" } };
      expect(roundTrip(value)).toEqual({ id: "custom" });
    });
  });

  describe("errors", () => {
    it.effect("a circular structure fails with CborEncodeError", () =>
      Effect.gen(function* () {
        const value: Record<string, unknown> = {};
        value.self = value;
        const error = yield* Effect.flip(Cbor.encode(value));
        expect(error._tag).toBe("CborEncodeError");
      }),
    );

    it("a repeated (non-circular) reference encodes", () => {
      const shared = { x: 1 };
      expect(roundTrip({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
    });

    for (const [name, bytes] of [
      ["truncated input", "8301"],
      ["trailing bytes", "0101"],
      ["a lone break", "ff"],
      ["invalid UTF-8", "62c328"],
      ["a reserved additional info", "1c"],
      ["an array longer than the input", "9a7fffffff"],
      ["a nested indefinite chunk", "5f5f4101ffff"],
      ["a wrong-type chunk", "5f6161ff"],
    ] as const) {
      it.effect(`${name} fails with CborDecodeError`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Cbor.decode(hex(bytes)));
          expect(error._tag).toBe("CborDecodeError");
        }),
      );
    }

    it.effect("nesting deeper than the limit fails instead of exhausting the stack", () =>
      Effect.gen(function* () {
        const deep = new Uint8Array(100_000).fill(0x81);
        const error = yield* Effect.flip(Cbor.decode(deep));
        expect(error._tag).toBe("CborDecodeError");
      }),
    );
  });

  describe("sequence decoder", () => {
    const values = [1, "two", { three: [3] }, new Uint8Array([4, 4]), undefined, -5n];
    const encoded = values.map((value) => Cbor.encodeUnsafe(value));
    const joined = new Uint8Array(encoded.reduce((n, bytes) => n + bytes.length, 0));
    encoded.reduce((at, bytes) => (joined.set(bytes, at), at + bytes.length), 0);

    it("decodes values split across every possible chunk boundary", () => {
      const decoder = Cbor.makeSequenceDecoder();
      const out: unknown[] = [];
      for (let i = 0; i < joined.length; i++) out.push(...decoder.push(joined.subarray(i, i + 1)));
      decoder.end();
      expect(out).toEqual(values);
    });

    it("decodes a whole sequence pushed at once", () => {
      const decoder = Cbor.makeSequenceDecoder();
      expect(decoder.push(joined)).toEqual(values);
      decoder.end();
    });

    it("end fails when the input stopped mid-value", () => {
      const decoder = Cbor.makeSequenceDecoder();
      decoder.push(joined.subarray(0, joined.length - 1));
      expect(() => decoder.end()).toThrow();
    });
  });
});

class Api extends RpcGroup.make(
  Rpc.make("Echo", {
    payload: { text: Schema.String, bytes: Schema.Uint8Array },
    success: Schema.Struct({ text: Schema.String, bytes: Schema.Uint8Array }),
  }),
  Rpc.make("Count", { payload: { n: Schema.Number }, success: Schema.Number, stream: true }),
) {}

const ApiLive = Api.toLayer({
  Echo: (payload) => Effect.succeed(payload),
  Count: ({ n }) => Stream.range(1, n),
});

describe("Cbor.layerRpcSerialization", { tags: ["unit", "local"] }, () => {
  it.effect("carries Effect RPC calls and streams over HTTP", () =>
    Effect.gen(function* () {
      const handler = yield* RpcServer.toHttpEffect(Api).pipe(
        Effect.provide(Layer.mergeAll(ApiLive, Cbor.layerRpcSerialization)),
      );
      const web = HttpEffect.toWebHandler(handler as never);
      let contentType: string | null = null;
      const fetchImpl = ((url: string, init?: RequestInit) => {
        const request = new Request(url, init);
        contentType = request.headers.get("content-type");
        return web(request);
      }) as typeof globalThis.fetch;

      const client = yield* RpcClient.make(Api).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: "http://rpc/" }).pipe(
            Layer.provide(Cbor.layerRpcSerialization),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
          ),
        ),
      );

      const echoed = yield* client.Echo({ text: "hi", bytes: new Uint8Array([1, 2, 255]) });
      expect(echoed).toEqual({ text: "hi", bytes: new Uint8Array([1, 2, 255]) });
      expect(contentType).toBe("application/cbor");

      const counted = yield* Stream.runCollect(client.Count({ n: 5 }));
      expect(Array.from(counted)).toEqual([1, 2, 3, 4, 5]);
    }).pipe(Effect.scoped),
  );
});
