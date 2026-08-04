import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "waku-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

test.provider(
  "Waku dev: local dev server renders RSC SSR with bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-waku-dev-",
        tempRoot,
        entries: [
          ".gitignore",
          "package.json",
          "tsconfig.json",
          "public",
          "src",
        ],
      });

      const bindingMarker = "waku-dev-binding-marker";

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Waku("WakuLocal", {
            rootDir,
            dev: { port: 0 },
            memo: {
              include: ["src/**", "public/**", "package.json", "tsconfig.json"],
            },
            env: {
              MESSAGE: bindingMarker,
            },
          });
        }),
      );

      // Local identity: the url points at the alchemy dev proxy — no
      // cloud Worker exists.
      expect(site.url).toBeDefined();
      expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

      // Dynamic RSC page rendered by waku's dev server (rsc environment
      // runs in workerd behind the proxy).
      yield* expectUrlContains(`${site.url!}/`, "WAKU_PAGE_MARKER", {
        timeout: "120 seconds",
        label: "waku dev dynamic home page",
      });

      // The page reads the `MESSAGE` binding from `cloudflare:workers`
      // env — proves alchemy-managed bindings reach the dev RSC server.
      yield* expectUrlContains(`${site.url!}/`, `MESSAGE=${bindingMarker}`, {
        timeout: "60 seconds",
        label: "waku dev env binding in SSR output",
      });

      // Static asset from `public/` through the dev server.
      yield* expectUrlContains(`${site.url!}/hello.txt`, "hello from public/", {
        timeout: "60 seconds",
        label: "waku dev static asset",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
