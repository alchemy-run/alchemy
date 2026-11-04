import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Provisioning from "@/State/Provisioning.ts";
import { StateStoreError } from "@/State/State.ts";

/** The command a missing store's error asks CI to run first. */
const hint = (store: Provisioning.StoreRef) =>
  Provisioning.deployMissing(store, Effect.void).pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof StateStoreError ? error.requires?.command : error)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CI: "true" } }))),
  );

describe("missing store hint", { tags: ["unit"] }, () => {
  it.effect("names every flag that addresses the store", () =>
    Effect.gen(function* () {
      const command = yield* hint({
        backend: "cloudflare",
        label: "Cloudflare State Store 'w'",
        flags: { name: "w", domain: "state.example.com" },
      });
      expect(command).toBe(
        "alchemy state bootstrap --backend cloudflare --name w --domain state.example.com",
      );
    }),
  );

  it.effect("leaves out flags that aren't set", () =>
    Effect.gen(function* () {
      const command = yield* hint({
        backend: "aws",
        label: "DynamoDB state table",
        flags: { name: undefined },
      });
      expect(command).toBe("alchemy state bootstrap --backend aws");
    }),
  );

  it.effect("asks for the configured bootstrap when only the stack describes the store", () =>
    Effect.gen(function* () {
      const command = yield* hint({
        backend: "cloudflare",
        label: "Cloudflare State Store 'w'",
        flags: { name: "w" },
        configured: true,
      });
      expect(command).toBe("alchemy state bootstrap");
    }),
  );
});
