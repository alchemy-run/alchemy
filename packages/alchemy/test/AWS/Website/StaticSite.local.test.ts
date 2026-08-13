import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../Local/fixtures/raw.ts";
import EffectStaticSite, { SiteData } from "./fixtures/effect-static-site.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "staticsite-dev",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

describe("AWS.Website.StaticSite local", () => {
  /**
   * The `dev.command` path: `alchemy dev` skips the build/upload entirely
   * and spawns the command as a long-lived child in the sidecar
   * (`Command.Dev`). The URL the child prints to stdout becomes the site's
   * `url`, and no cloud resources are declared at all.
   */
  test.provider(
    "dev.command serves the site through the external dev server",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-aws-staticsite-dev-cmd-",
          tempRoot,
          entries: ["serve.mjs", "site"],
        });

        const marker = "aws-staticsite-dev-command-marker";
        yield* fs.writeFileString(
          path.join(cwd, "site", "index.html"),
          htmlPage(marker),
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("DevCmdSite", {
              path: cwd,
              dev: {
                command: "bun serve.mjs",
                env: { DEV_MARKER: "aws-staticsite-dev-env-marker" },
              },
            });
            return { site };
          }),
        );

        // The site's url is the dev server's own localhost address,
        // extracted from the child's stdout — and no cloud rows exist
        // (proof no AWS call ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.site.bucket).toBeUndefined();
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.files).toBeUndefined();

        // Dev-mode urls contract: `urls` is exactly the dev server's URL
        // and `url` is always `urls[0]`.
        expect(deployed.site.urls).toEqual([url]);
        expect(deployed.site.url).toBe(deployed.site.urls[0]);

        // Content serves through the dev server straight from `site/`.
        yield* expectUrlContains(`${url}/`, marker, {
          timeout: "60 seconds",
          label: "dev.command index",
        });
        yield* expectUrlContains(`${url}/index.html`, marker, {
          timeout: "30 seconds",
          label: "dev.command explicit path",
        });

        // `dev.env` reached the spawned child process.
        yield* expectUrlContains(
          `${url}/__dev-env`,
          "aws-staticsite-dev-env-marker",
          {
            timeout: "30 seconds",
            label: "dev.command env passthrough",
          },
        );

        // ── Live edit: rewrite the content in place. The stack is NOT
        // re-applied — the external dev server reads from disk per request,
        // so the very next fetch must serve the new content ──────────────
        const editedMarker = "aws-staticsite-dev-command-marker-v2";
        yield* fs.writeFileString(
          path.join(cwd, "site", "index.html"),
          htmlPage(editedMarker),
        );
        yield* expectUrlContains(`${url}/`, editedMarker, {
          timeout: "30 seconds",
          label: "dev.command index after live edit",
        });
        // `dev.env` still reaches the (unchanged, long-lived) child.
        yield* expectUrlContains(
          `${url}/__dev-env`,
          "aws-staticsite-dev-env-marker",
          { label: "dev.command env passthrough after live edit" },
        );

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful StaticSite (DESIGN §4.2): the Effect program IS the server —
// in dev it deploys into the floci Lambda emulator (RPC-sidecar-hosted
// provider dual) while the frontend runs as the external `dev.command`
// server. No CDN resources exist at all.
// ─────────────────────────────────────────────────────────────────────

describe("AWS.Website.StaticSite local (effectful)", () => {
  test.provider.skipIf(!dockerAvailable)(
    "effectful StaticSite dev: /api/* serves from the emulated effect Lambda, dev.command serves the frontend",
    (stack) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;

        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* EffectStaticSite;
            // The impl's `yield* SiteData` registers the bucket at the
            // root (registration is idempotent per FQN) — this resolves
            // the SAME row the binding uses.
            const data = yield* SiteData;
            return { data, site };
          }),
        );

        // The site's url is the frontend dev server's own localhost
        // address, and no CDN resources exist (proof no cloud CDN call
        // ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.site.bucket).toBeUndefined();
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.files).toBeUndefined();
        expect(deployed.site.urls).toEqual([url]);

        // Emulator identity for the effect server Lambda: a dummy-account
        // ARN and a `*.lambda-url.*.localhost:4566` Function URL — the
        // live cloud can never produce these.
        expect(deployed.site.server.functionArn).toContain(":000000000000:");
        const serverUrl = deployed.site.serverUrl! as string;
        expect(serverUrl).toContain("localhost:4566");

        // The frontend serves through the external dev server.
        yield* expectUrlContains(
          `${url}/`,
          "StaticSite dev fixture placeholder",
          { timeout: "60 seconds", label: "effectful dev frontend" },
        );

        // The effect fetch answers /api/* on the emulated Lambda. First
        // invoke pulls the Lambda runtime image (cold), then warm.
        const ping = yield* client
          .get(new URL("/api/ping", serverUrl).toString())
          .pipe(
            Effect.flatMap((response) =>
              Effect.map(response.text, (body) => ({
                status: response.status,
                body,
              })),
            ),
            Effect.retry({
              while: (): boolean => true,
              schedule: Schedule.spaced("2 seconds"),
              times: 60,
            }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (res): boolean => res.status === 200,
              times: 60,
            }),
          );
        expect(ping.status).toBe(200);
        expect(ping.body).toContain('"pong":true');

        // An unmatched /api/* path is answered by the effect fetch's own
        // 404 — the effect program owns the whole /api/* space.
        const miss = yield* client
          .get(new URL("/api/definitely-not-here", serverUrl).toString())
          .pipe(
            Effect.flatMap((response) =>
              Effect.map(response.text, (body) => ({
                status: response.status,
                body,
              })),
            ),
            Effect.retry({
              while: (): boolean => true,
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          );
        expect(miss.status).toBe(404);
        expect(miss.body).toContain("unknown api route");

        yield* stack.destroy();
      }),
    { timeout: 540_000 },
  );
});
