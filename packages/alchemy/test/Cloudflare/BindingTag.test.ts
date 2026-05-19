import { makeBindingTag } from "../../src/Cloudflare/BindingTag.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface TestClient {
  readonly id: string;
}

interface TestResource {
  readonly logicalId: string;
}

const resource: TestResource = {
  logicalId: "UnderlyingResource",
};

const client: TestClient = {
  id: "client",
};

describe("Cloudflare BindingTag", () => {
  it.effect("runs the bind effect when the tag layer is initialized", () =>
    Effect.gen(function* () {
      const bound = yield* Ref.make<Array<string>>([]);

      class RuntimeBinding extends makeBindingTag<
        RuntimeBinding,
        "RuntimeBinding",
        TestClient
      >(
        "RuntimeBinding",
        Ref.update(bound, (calls) => [...calls, resource.logicalId]).pipe(
          Effect.as(client),
        ),
      ) {}

      expect(yield* Ref.get(bound)).toEqual([]);

      const RuntimeBindingLive = yield* RuntimeBinding.layer;

      expect(yield* Ref.get(bound)).toEqual(["UnderlyingResource"]);
      expect(
        yield* RuntimeBinding.pipe(Effect.provide(RuntimeBindingLive)),
      ).toBe(client);
      expect(yield* Ref.get(bound)).toEqual(["UnderlyingResource"]);
    }),
  );

  it.effect("runs the bind effect once for each layer initialization", () =>
    Effect.gen(function* () {
      const bindCount = yield* Ref.make(0);

      class RuntimeBinding extends makeBindingTag<
        RuntimeBinding,
        "RuntimeBinding",
        TestClient
      >(
        "RuntimeBinding",
        Ref.update(bindCount, (count) => count + 1).pipe(Effect.as(client)),
      ) {}

      const FirstLive = yield* RuntimeBinding.layer;
      const SecondLive = yield* RuntimeBinding.layer;

      expect(yield* Ref.get(bindCount)).toBe(2);
      expect(yield* RuntimeBinding.pipe(Effect.provide(FirstLive))).toBe(
        client,
      );
      expect(yield* RuntimeBinding.pipe(Effect.provide(SecondLive))).toBe(
        client,
      );
      expect(yield* Ref.get(bindCount)).toBe(2);
    }),
  );
});
