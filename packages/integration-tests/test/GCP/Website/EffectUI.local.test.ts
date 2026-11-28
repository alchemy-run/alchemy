import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { effectUIFixture, effectUIMemo, verifyEffectUIDev } from "../../Website/EffectUI.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: GCP.providers(), dev: true });

describe(
  "GCP.Website.EffectUI local",
  { tags: ["provider:gcp", "provider:gcp:website", "local"] },
  () => {
    test.provider(
      "dev renders pages in the app's own Vite dev server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* effectUIFixture("hybrid");
          const site = yield* stack.deploy(
            GCP.Website.EffectUI("Web", { rootDir, memo: effectUIMemo }),
          );

          // A localhost URL and no cloud resources: proof no GCP call ran.
          expect(site.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\]):\d+\/?$/);
          expect(site.service).toBeUndefined();
          yield* verifyEffectUIDev(site.url! as string);

          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );
  },
);
