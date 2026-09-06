import * as Rpc from "@/Local/RpcConfigProvider.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

const source = (token: string) =>
  ConfigProvider.fromUnknown({ APP: { TOKEN: token } }).pipe(
    ConfigProvider.nested("app"),
  );

describe("RPC ConfigProvider transformations", () => {
  it.effect("applies sidecar transforms after parent transforms", () =>
    Effect.gen(function* () {
      const parent = source("managed");
      const bridge = Rpc.make(Rpc.reader(parent));
      const direct = ConfigProvider.constantCase(parent);
      const remote = ConfigProvider.constantCase(bridge.provider);
      expect(yield* remote.load(["token"])).toEqual(
        yield* direct.load(["token"]),
      );
      expect(yield* remote.load(["token"])).toEqual(
        ConfigProvider.makeValue("managed"),
      );
      expect(
        yield* Effect.promise(() =>
          bridge.changed(Rpc.reader(source("managed"))),
        ),
      ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          bridge.changed(Rpc.reader(source("rotated"))),
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "preserves independently transformed fallbacks and custom closures",
    () =>
      Effect.gen(function* () {
        const parent = ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ FIRST: {} }).pipe(
            ConfigProvider.nested("first"),
          ),
          ConfigProvider.fromUnknown({
            SECOND: { PREFIX_TOKEN: "fallback" },
          }).pipe(ConfigProvider.nested("second")),
        );
        const prefix = "prefix_";
        const transform = (provider: ConfigProvider.ConfigProvider) =>
          provider.pipe(
            ConfigProvider.mapInput((path) =>
              path.map((segment, index) =>
                index === path.length - 1 ? prefix + segment : segment,
              ),
            ),
            ConfigProvider.constantCase,
          );
        const bridge = Rpc.make(Rpc.reader(parent));
        expect(yield* transform(bridge.provider).load(["token"])).toEqual(
          yield* transform(parent).load(["token"]),
        );
        expect(yield* transform(bridge.provider).load(["token"])).toEqual(
          ConfigProvider.makeValue("fallback"),
        );
        expect(yield* bridge.provider.load(["token"])).toBeUndefined();
      }),
  );
  it.effect("keeps transformed misses in reload comparisons", () =>
    Effect.gen(function* () {
      const bridge = Rpc.make(
        Rpc.reader(
          ConfigProvider.fromUnknown({ APP: {} }).pipe(
            ConfigProvider.nested("app"),
          ),
        ),
      );
      expect(
        yield* ConfigProvider.constantCase(bridge.provider).load(["token"]),
      ).toBeUndefined();
      expect(
        yield* Effect.promise(() =>
          bridge.changed(Rpc.reader(source("added"))),
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "reports real source failures without forwarding their contents",
    () =>
      Effect.gen(function* () {
        const parent = ConfigProvider.make(() =>
          Effect.fail(
            new ConfigProvider.SourceError({ message: "secret-diagnostic" }),
          ),
        );
        const error = yield* ConfigProvider.constantCase(
          Rpc.make(Rpc.reader(parent)).provider,
        )
          .load(["token"])
          .pipe(Effect.flip);
        expect(error.message).toBe("Unable to read sidecar configuration");
      }),
  );
});
