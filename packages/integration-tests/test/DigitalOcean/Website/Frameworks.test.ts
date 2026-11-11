import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getApp } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { TestRegistry } from "../fixtures/app/shared.ts";
import { isGone, logLevel, skipSlow, waitForAppHost } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:website", "live"];
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtures = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures");
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".alchemy",
  ".output",
  ".next",
  ".svelte-kit",
  ".vinxi",
  ".react-router",
  ".waku",
  ".tanstack",
]);

type Composite = (
  id: string,
  props: DigitalOcean.Website.FrameworkSiteProps,
) => Effect.Effect<DigitalOcean.Website.Website, never, any>;

const cases: ReadonlyArray<{
  name: string;
  site: Composite;
  fixture: string;
  path: string;
  marker: string;
}> = [
  {
    name: "Astro",
    site: DigitalOcean.Website.Astro,
    fixture: `${fixtures}/astro-app`,
    path: "/",
    marker: "ASTRO_AWS_PAGE_MARKER",
  },
  {
    name: "Next.js",
    site: DigitalOcean.Website.Nextjs,
    fixture: `${fixtures}/nextjs-app`,
    path: "/",
    marker: "NEXTJS_AWS_PAGE_MARKER",
  },
  {
    name: "Nuxt",
    site: DigitalOcean.Website.Nuxt,
    fixture: `${fixtures}/nuxt-app`,
    path: "/health",
    marker: "ok",
  },
  {
    name: "SvelteKit",
    site: DigitalOcean.Website.SvelteKit,
    fixture: `${fixtures}/sveltekit-app`,
    path: "/",
    marker: "SVELTEKIT_AWS_PAGE_MARKER",
  },
  {
    name: "SolidStart",
    site: DigitalOcean.Website.SolidStart,
    fixture: `${fixtures}/solidstart-app`,
    path: "/health",
    marker: "ok",
  },
  {
    name: "React Router",
    site: DigitalOcean.Website.ReactRouter,
    fixture: `${fixtures}/react-router-app`,
    path: "/",
    marker: "REACT_ROUTER_AWS_PAGE_MARKER",
  },
  {
    name: "TanStack Start",
    site: DigitalOcean.Website.TanStackStart,
    fixture: `${fixtures}/tanstack-start-app`,
    path: "/",
    marker: "TANSTACK_AWS_PAGE_MARKER",
  },
  {
    name: "Waku",
    site: DigitalOcean.Website.Waku,
    fixture: `${fixtures}/waku-app`,
    path: "/",
    marker: "WAKU_AWS_PAGE_MARKER",
  },
  {
    name: "Octane",
    site: DigitalOcean.Website.Octane,
    fixture: `${fixtures}/octane-app`,
    path: "/",
    marker: "OCTANE_AWS_PAGE_MARKER",
  },
  {
    name: "Foldkit",
    site: DigitalOcean.Website.Foldkit,
    fixture: pathe.resolve(import.meta.dirname, "../../Cloudflare/Website/foldkit-fixture"),
    path: "/",
    marker: "Foldkit Fixture",
  },
  {
    name: "Vocs",
    site: DigitalOcean.Website.Vocs,
    fixture: pathe.resolve(import.meta.dirname, "../../../../../examples/cloudflare-website-vocs"),
    path: "/",
    marker: "Alchemy with Vocs",
  },
];

// A team holds one registry, so each site deploys, answers and is
// destroyed inside one test holding the registry lock.
for (const c of cases) {
  test.provider.skipIf(skipSlow)(
    `${c.name} on App Platform: build, deploy, GET ${c.path}, destroy`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const entries = (yield* fs.readDirectory(c.fixture)).filter((name) => !SKIP.has(name));
        const rootDir = yield* cloneFixture(c.fixture, {
          prefix: `alchemy-${c.name.toLowerCase().replaceAll(/[^a-z]/g, "")}-digitalocean-`,
          tempRoot,
          entries,
        });
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* c.site("Web", { rootDir, registry: TestRegistry });
            return { url: site.url, appId: site.app?.appId };
          }),
        );
        const url = deployed.url as string;
        expect(url).toMatch(/^https:\/\/.+\.ondigitalocean\.app/);
        yield* waitForAppHost(url);
        yield* expectUrlContains(`${url}${c.path}`, c.marker, {
          timeout: "120 seconds",
          label: `${c.name} ${c.path}`,
        });
        yield* stack.destroy();
        expect(yield* isGone(getApp({ id: deployed.appId! }))).toBe(true);
      }).pipe(logLevel),
    { tags: LIVE_TAGS, timeout: 2_700_000, exclusive: "digitalocean:registry" },
  );
}
