import { DevServer, DevServerProvider } from "@/Build/DevServer.ts";
import * as Provider from "@/Provider.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({
  // DevServer is provider-agnostic — register it directly without dragging
  // in a cloud provider's auth chain.
  providers: DevServerProvider(),
  dev: true,
});

test.provider(
  "list returns [] (non-listable local dev-server process)",
  () =>
    Effect.gen(function* () {
      // DevServer is a local dev-server child process, not a cloud resource —
      // there is no remote enumeration API, so list() is the non-listable
      // pattern and always returns []. No deploy is needed to observe this.
      const provider = yield* Provider.findProvider(DevServer);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { timeout: 30_000 },
);
