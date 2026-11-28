import * as Hetzner from "@alchemy.run/hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as servers from "@distilled.cloud/hetzner/servers";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";
import { hetznerPrimaryIps } from "../limit.ts";

const { test } = Test.make({ limit: hetznerPrimaryIps, providers: Hetzner.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (id: number) =>
  servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe.sequential(
  "Hetzner EffectUI rendering modes",
  { tags: ["provider:hetzner", "provider:hetzner:website", "live"] },
  () => {
    for (const mode of effectUIModes) {
      test.provider.skipIf(mode !== "spa" && !!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* effectUIFixture(mode);

            const site = yield* stack.deploy(
              Hetzner.Website.EffectUI("Web", { rootDir, memo: effectUIMemo }),
            );
            expect(site.url).toBeDefined();
            expect(site.server).toBeDefined();
            const serverId = site.server!.serverId;
            yield* servers.getServer({ id: serverId });
            yield* verifyEffectUIRendering(site.url!, mode, { runtime: /Node\.js/ });

            yield* stack.destroy();
            expect(yield* waitUntilGone(serverId)).toEqual("gone");
          }).pipe(logLevel),
        { timeout: 180_000 },
      );
    }
  },
);
