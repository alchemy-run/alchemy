import { describe, expect, it } from "@alchemy.run/test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runtimeConfigProvider } from "@/Runtime.ts";
import { packEnvValue, unwrapRedactedMarker } from "@/RuntimeContext.ts";

// Strings a user can put in a Worker `env` prop, a dashboard or a host
// environment that `JSON.parse` would turn into something else (#2269,
// #2847, #3497). A runtime `Config` read must return each one unchanged.
const jsonLooking = [
  "12345678901.12345678901234",
  "9007199254740993",
  "1290780104129730",
  "1.0",
  "1e3",
  "-0",
  "0",
  "42",
  "false",
  "true",
  "null",
  '"quoted"',
  '{"a":1}',
  '{ "a": 1 }',
  "[1, 2]",
  " 7",
  '{"_tag":"Redacted"}',
  '{"_tag":"Redacted","value":"x","extra":1}',
  '{"_tag":"Other","value":1}',
  '[{"_tag":"Redacted","value":"x"}]',
];

const plain = ["my-queue", "https://example.com/a?b=c", "", "line\nbreak", "{not json"];

describe("unwrapRedactedMarker", { tags: ["unit", "local"] }, () => {
  it("returns every string that isn't a Redacted marker verbatim", () => {
    for (const raw of [...jsonLooking, ...plain]) {
      expect(unwrapRedactedMarker(raw)).toBe(raw);
    }
  });

  it("unwraps a bound Redacted marker to its source string", () => {
    for (const source of [...jsonLooking, ...plain]) {
      expect(unwrapRedactedMarker(packEnvValue(Redacted.make(source)))).toBe(source);
    }
  });

  it("unwraps a marker that holds a marker-shaped string exactly once", () => {
    const inner = packEnvValue(Redacted.make("s3cret"));
    expect(unwrapRedactedMarker(packEnvValue(Redacted.make(inner)))).toBe(inner);
  });

  it("serialises a marker's structured value as JSON", () => {
    expect(unwrapRedactedMarker(packEnvValue(Redacted.make({ token: "abc" })))).toBe(
      '{"token":"abc"}',
    );
  });
});

const readAll = <A>(config: (key: string) => Config.Config<A>, env: Record<string, string>) =>
  Effect.all(
    Object.fromEntries(Object.keys(env).map((key) => [key, config(key)])) as Record<
      string,
      Config.Config<A>
    >,
  );

const providers = (env: Record<string, string>) => ({
  // workerd: the env object (`ConfigProvider.fromUnknown`)
  fromUnknown: runtimeConfigProvider(ConfigProvider.fromUnknown(env)),
  // Node hosts: `process.env` (`ConfigProvider.fromEnv`)
  fromEnv: runtimeConfigProvider(ConfigProvider.fromEnv({ env })),
});

describe("runtimeConfigProvider", { tags: ["unit", "local"] }, () => {
  const verbatim = Object.fromEntries(jsonLooking.map((value, i) => [`VAR_${i}`, value]));

  for (const [name, provider] of Object.entries(providers(verbatim))) {
    it.effect(`${name}: Config.String reads verbatim env strings unchanged`, () =>
      Effect.gen(function* () {
        const read = yield* readAll(Config.String, verbatim).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
        );
        expect(read).toEqual(verbatim);
      }),
    );
  }

  const bound = Object.fromEntries(
    jsonLooking.map((value, i) => [`VAR_${i}`, packEnvValue(Redacted.make(value))]),
  );

  for (const [name, provider] of Object.entries(providers(bound))) {
    it.effect(`${name}: Config.String unwraps values the interceptor bound`, () =>
      Effect.gen(function* () {
        const read = yield* readAll(Config.String, bound).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
        );
        expect(read).toEqual(verbatim);
      }),
    );
  }

  const typed = {
    FLAG_RAW: "false",
    FLAG_BOUND: packEnvValue(Redacted.make("false")),
    PORT_RAW: "8080",
    PORT_BOUND: packEnvValue(Redacted.make("8080")),
    TOKEN_BOUND: packEnvValue(Redacted.make("12345678901.12345678901234")),
  };

  for (const [name, provider] of Object.entries(providers(typed))) {
    it.effect(`${name}: typed Configs decode from the raw string`, () =>
      Effect.gen(function* () {
        const read = yield* Effect.all({
          flagRaw: Config.Boolean("FLAG_RAW"),
          flagBound: Config.Boolean("FLAG_BOUND"),
          portRaw: Config.Number("PORT_RAW"),
          portBound: Config.Number("PORT_BOUND"),
          token: Config.Redacted("TOKEN_BOUND"),
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
        expect(read.flagRaw).toBe(false);
        expect(read.flagBound).toBe(false);
        expect(read.portRaw).toBe(8080);
        expect(read.portBound).toBe(8080);
        expect(Redacted.value(read.token)).toBe("12345678901.12345678901234");
      }),
    );
  }

  it.effect("unwraps the scalar of a Record or Array node (`PORT` beside `PORT_X`)", () =>
    Effect.gen(function* () {
      const env = {
        PORT: packEnvValue(Redacted.make("8080")),
        PORT_CHILD: "x",
        LIST: packEnvValue(Redacted.make("1.0")),
        LIST_0: "x",
        RAW: "1e3",
        RAW_CHILD: "x",
      };
      const read = yield* Effect.all({
        port: Config.Number("PORT"),
        list: Config.String("LIST"),
        raw: Config.String("RAW"),
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          runtimeConfigProvider(ConfigProvider.fromEnv({ env })),
        ),
      );
      expect(read).toEqual({ port: 8080, list: "1.0", raw: "1e3" });
    }),
  );

  it.effect("always reads ALCHEMY_PHASE as runtime", () =>
    Effect.gen(function* () {
      const phase = yield* Config.String("ALCHEMY_PHASE").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          runtimeConfigProvider(ConfigProvider.fromEnv({ env: { ALCHEMY_PHASE: "plan" } })),
        ),
      );
      expect(phase).toBe("runtime");
    }),
  );

  it.effect("lists the whole env at the root, not just ALCHEMY_PHASE", () =>
    Effect.gen(function* () {
      const node = yield* runtimeConfigProvider(
        ConfigProvider.fromEnv({ env: { A: "1", B: "2" } }),
      ).load([]);
      expect(node?._tag === "Record" ? [...node.keys].sort() : node).toEqual(["A", "B"]);
    }),
  );

  it.effect("falls back to the sanitized key the interceptor bound under", () =>
    Effect.gen(function* () {
      const env = { my_key: packEnvValue(Redacted.make("1.0")) };
      const value = yield* Config.String("my.key").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          runtimeConfigProvider(ConfigProvider.fromEnv({ env })),
        ),
      );
      expect(value).toBe("1.0");
    }),
  );
});
