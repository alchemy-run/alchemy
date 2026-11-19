import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as proxy from "@distilled.cloud/modal/proxy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

// Proxies need Modal's Team plan.
test.provider.skipIf(!process.env.MODAL_TEST_PROXY)(
  "create a proxy, add an IP, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const one = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Proxy("Proxy", {});
        }),
      );
      expect(one.ips.length).toBe(1);
      const two = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Proxy("Proxy", { ips: 2 });
        }),
      );
      expect(two.proxyId).toBe(one.proxyId);
      expect(two.ips.length).toBe(2);
      yield* stack.destroy();
      const gone = yield* proxy.getProxy({ name: one.name, environmentName: "" }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ProxyNotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:modal", "provider:modal:proxy", "live"], timeout: 180_000 },
);
