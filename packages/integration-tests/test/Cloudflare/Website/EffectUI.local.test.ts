import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { effectUIFixture, effectUIMemo } from "../../Website/EffectUI.ts";
import { expectDirectStatus, expectUrlContains } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

describe.concurrent(
  "EffectUI dev",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:website", "provider:cloudflare:worker"],
  },
  () => {
    // A browser-only app gets the SPA fallback in dev that its build derives
    // on deploy, and the resource's own `assets` still override it.
    test.provider(
      "EffectUI dev: a browser-only app serves its shell for deep links",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* effectUIFixture("spa");
          const navigate = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };

          const site = yield* stack.deploy(
            Cloudflare.Website.EffectUI("EffectUISpaLocal", {
              rootDir,
              dev: { port: 0 },
              memo: effectUIMemo,
            }),
          );
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

          yield* expectUrlContains(`${site.url!}/counter/42`, "<!--app-html-->", {
            timeout: "30 seconds",
            label: "effect-ui dev spa deep link",
            headers: navigate,
          });

          const overridden = yield* stack.deploy(
            Cloudflare.Website.EffectUI("EffectUISpaLocal", {
              rootDir,
              dev: { port: 0 },
              memo: effectUIMemo,
              assets: { notFoundHandling: "none" },
            }),
          );
          yield* expectDirectStatus(`${overridden.url!}/counter/42`, 404, {
            timeout: "30 seconds",
            label: "effect-ui dev spa override deep link",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["local"], timeout: 120_000 },
    );

    // `HtmlServerVite`'s server renders every page in workerd under
    // `alchemy dev`, prerendered ones included: each page stamps the
    // `count` query into its markup, which tells a render from a template.
    test.provider(
      "EffectUI dev: a server-rendered app renders in the local Worker",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* effectUIFixture("hybrid");
          const site = yield* stack.deploy(
            Cloudflare.Website.EffectUI("EffectUISsrLocal", {
              rootDir,
              dev: { port: 0 },
              memo: effectUIMemo,
            }),
          );

          // Local identity: the url points at the alchemy dev proxy — no
          // cloud Worker exists.
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

          yield* expectUrlContains(`${site.url!}/about?count=7`, 'id="count">7<', {
            timeout: "30 seconds",
            label: "effect-ui dev ssr prerendered page",
          });
          yield* expectUrlContains(`${site.url!}/counter/42?count=3`, 'id="count">3<', {
            timeout: "15 seconds",
            label: "effect-ui dev ssr deep link",
          });
          // Rendered by the Worker in workerd, not by Vite's Node server.
          yield* expectUrlContains(`${site.url!}/__runtime`, "Cloudflare-Workers", {
            timeout: "15 seconds",
            label: "effect-ui dev runtime",
          });
          yield* expectDirectStatus(`${site.url!}/not-a-page`, 404, {
            timeout: "15 seconds",
            label: "effect-ui dev not found",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["local"], timeout: 120_000 },
    );

    /**
     * `Alchemy.remote()` opts the whole site OUT of local emulation: even under
     * `alchemy dev` the build runs, the Worker it emits deploys to real
     * Cloudflare, and destroy deletes the cloud Worker (the state row is
     * stamped live).
     */
    test.provider(
      "EffectUI dev: Alchemy.remote() deploys the real Worker and destroy removes it",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* effectUIFixture("hybrid");
          const site = yield* stack.deploy(
            Cloudflare.Website.EffectUI("EffectUIRemoteSite", {
              rootDir,
              workersDev: true,
              compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
              memo: effectUIMemo,
            }).pipe(Alchemy.remote()),
          );

          // Real identity: a non-local URL and a Worker that exists on
          // Cloudflare.
          expect(site.url).toBeDefined();
          expect(site.url).not.toMatch(/^http:\/\/localhost/);
          yield* expectWorkerExists(site.workerName, accountId);

          // The deployed Worker renders a page on request.
          yield* expectUrlContains(`${site.url!}/counter/42?count=7`, 'id="count">7<', {
            timeout: "30 seconds",
            label: "remote() effect-ui ssr page in dev mode",
          });
          // The route the fixture prerenders is a file: the query never
          // reaches a render.
          yield* expectUrlContains(`${site.url!}/about?count=7`, 'id="count">0<', {
            timeout: "15 seconds",
            label: "remote() effect-ui prerendered page in dev mode",
          });

          yield* stack.destroy();

          // The stamped-live row deletes the real Worker even in a dev run.
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120_000 },
    );
  },
);
