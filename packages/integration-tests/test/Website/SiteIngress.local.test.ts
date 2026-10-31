import * as AWS from "@alchemy.run/aws";
import * as Fly from "@alchemy.run/fly";
import * as GCP from "@alchemy.run/gcp";
import * as Hetzner from "@alchemy.run/hetzner";
import { providers as neonProviders } from "@alchemy.run/neon/Providers";
import { Vite as NeonVite } from "@alchemy.run/neon/Website/Vite";
import * as Prisma from "@alchemy.run/prisma";
import * as Railway from "@alchemy.run/railway";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { forwarderConfig, getRouted } from "@alchemy.run/test/IngressForwarder";
import type { IngressConfig } from "alchemy/Local/Ingress";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";

const fixtureDir = pathe.resolve(import.meta.dirname, "../Cloudflare/Website/vite-spa-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../.tmp");
const fixtureEntries = ["index.html", "package.json", "src"];

type ViteSite = (
  id: string,
  props: { rootDir: string; dev: { ingress: IngressConfig } },
) => Effect.Effect<{ url: unknown }, any, any>;

/**
 * Every site composite builds its server as `"Build"`; the route must be called
 * after the site instead, so two sites never share a name. Each composite runs
 * Vite's own dev server behind the real `alchemy dev` sidecar, which resolves
 * the forwarder from `@alchemy.run/test` (the package contributes it).
 */
const siteRoutedAfterItsId = (
  provider: string,
  providers: Layer.Layer<any, never, any>,
  vite: ViteSite,
) => {
  const { test } = Test.make({ providers, dev: true });

  test.provider(
    `${provider}.Website.Vite calls its dev route after the site`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: `alchemy-site-ingress-${provider.toLowerCase()}-`,
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          vite("RoutedSite", { rootDir, dev: { ingress: forwarderConfig() } }),
        );

        const origin = site.url as string;
        expect(origin).toMatch(/^http:\/\/[a-z0-9-]+\.routedsite\.[a-z0-9-]+\.localhost:\d+$/);
        // Vite answers on the routed name.
        const answer = yield* getRouted(origin).pipe(
          Effect.flatMap((response) =>
            response.status === 200 ? Effect.succeed(response) : Effect.fail(response),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
          Effect.orDie,
        );
        expect(answer.body).toContain("Vite SPA fixture");

        yield* stack.destroy();
      }),
    {
      tags: [
        `provider:${provider.toLowerCase()}`,
        `provider:${provider.toLowerCase()}:website`,
        "local",
      ],
      timeout: 120_000,
    },
  );
};

siteRoutedAfterItsId("AWS", AWS.providers(), AWS.Website.Vite);
siteRoutedAfterItsId("Fly", Fly.providers(), Fly.Website.Vite);
siteRoutedAfterItsId("GCP", GCP.providers(), GCP.Website.Vite);
siteRoutedAfterItsId("Hetzner", Hetzner.providers(), Hetzner.Website.Vite);
siteRoutedAfterItsId("Neon", neonProviders(), NeonVite);
siteRoutedAfterItsId("Prisma", Prisma.providers(), Prisma.Website.Vite);
siteRoutedAfterItsId("Railway", Railway.providers(), Railway.Website.Vite);
