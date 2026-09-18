import { providers } from "@/Neon/Providers.ts";
import { WebsiteArtifact } from "@/Neon/Website/Artifact.ts";
import { deployWebsite } from "@/Neon/Website/FrameworkSite.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: providers() });

test.provider(
  "owned backend provisioning depends on artifact validation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          const artifact = yield* WebsiteArtifact("Artifact", {
            root: ".",
            distDir: "dist",
            static: {},
          });
          return yield* deployWebsite({}, artifact);
        }),
      );
      expect(plan.resources.Artifact?.downstream).toContain("Project");
      expect(plan.resources.Project?.action).toBe("create");
      expect(plan.resources.Function?.action).toBe("create");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
