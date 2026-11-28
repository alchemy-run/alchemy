import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { effectUIFixture, effectUIMemo, verifyEffectUIRendering } from "../../Website/EffectUI.ts";
import {
  assertSiteGone,
  cloudRunUrl,
  type DeployedService,
  liveOptions,
  logLevel,
  serviceIdentity,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

// One Cloud Run service walked through every rendering mode: each redeploy
// replaces the build, and every route must answer for the new mode.
test.provider.skipIf(!!process.env.FAST)(
  "EffectUI: spa, ssg, ssr and hybrid render every route across redeploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      let service: DeployedService | undefined;
      for (const mode of ["spa", "ssg", "ssr", "hybrid"] as const) {
        const rootDir = yield* effectUIFixture(mode);
        const site = yield* stack.deploy(
          GCP.Website.EffectUI("Web", { rootDir, memo: effectUIMemo }),
        );
        expect(site.url).toMatch(cloudRunUrl);
        expect(site.service).toBeDefined();
        service = serviceIdentity(site.service!);
        yield* verifyEffectUIRendering(site.url as string, mode, { runtime: /Node\.js/ });
      }

      yield* stack.destroy();
      yield* assertSiteGone(service!);
    }).pipe(logLevel),
  liveOptions(1_800_000),
);
