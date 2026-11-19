/**
 * `AWS.Lambda.WebFunction` under `alchemy dev`: the dualized provider deploys
 * the function, its revision and its endpoint into the floci emulator, which
 * serves the endpoint's URL from the host. `AWS.Website.*` sites do not reach
 * this path in dev; they run their framework's dev server instead.
 *
 * A source edit reaches the endpoint without another deploy: the sidecar
 * watch loop (`FlociWebFunctionProvider`) rebuilds, creates a revision with
 * only the code replaced and moves the endpoint to it. The tests rewrite a
 * CLONE of the fixture, so the repo tree stays clean.
 */
import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { FLOCI_CA_PATH } from "@alchemy.run/aws/Local/Floci";
import * as Region from "@alchemy.run/aws/Region";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { FLOCI_ENDPOINT } from "../Local/fixtures/raw.ts";

const main = fileURLToPath(new URL("./fixtures/web/async-server.ts", import.meta.url));
const devFixtureDir = fileURLToPath(new URL("./fixtures/floci-web-dev", import.meta.url));
const prebuiltDir = fileURLToPath(new URL("./fixtures/web/prebuilt", import.meta.url));

const { test } = Test.make({ providers: AWS.providers(), dev: true });

/** Floci-scoped context for the distilled calls the test makes itself. */
const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

/**
 * GET `url` until it answers 200; a new endpoint takes a moment to serve.
 * Floci terminates the endpoint's TLS with its own CA, which this process
 * did not trust at startup, so the request names it.
 */
const getText = Effect.fn(function* (url: string) {
  const fs = yield* FileSystem.FileSystem;
  const ca = yield* fs.readFileString(FLOCI_CA_PATH);
  return yield* Effect.tryPromise(async () => {
    const response = await fetch(url, { tls: { ca } } as RequestInit);
    if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
    return response.text();
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }));
});

/** GET `url` until its body passes `until`, as a hot swap lands without a deploy. */
const waitForText = (url: string, until: (body: string) => boolean) =>
  getText(url).pipe(Effect.repeat({ schedule: Schedule.spaced("250 millis"), until, times: 240 }));

const webFunctionExists = (functionName: string) =>
  LambdaWeb.getWebFunction({ functionName }).pipe(
    Effect.map(() => true),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
    Effect.provide(flociContext),
  );

test.provider(
  "dev deploys a Web Function into floci and serves it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (greeting: string) =>
        stack.deploy(
          AWS.Lambda.WebFunction("LocalWeb", {
            main,
            authType: "ApplicationManaged",
            env: { GREETING: greeting },
          }),
        );

      const fn = yield* deploy("local");
      // The emulator's account, so no AWS call created it.
      expect(fn.functionArn).toContain(":000000000000:");
      expect(yield* webFunctionExists(fn.functionName)).toBe(true);
      expect(yield* getText(fn.url)).toBe("greeting=local");

      // An update ships a new revision to the same endpoint.
      const updated = yield* deploy("updated");
      expect(updated.functionName).toBe(fn.functionName);
      expect(updated.revisionId).not.toBe(fn.revisionId);
      expect(
        yield* getText(updated.url).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (body) => body === "greeting=updated",
            times: 30,
          }),
        ),
      ).toBe("greeting=updated");

      yield* stack.destroy();
      expect(yield* webFunctionExists(fn.functionName)).toBe(false);
    }),
  {
    tags: ["provider:aws", "provider:aws:lambda", "local"],
    timeout: 240_000,
  },
);

test.provider(
  "dev hot-swaps a Web Function's code without a deploy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const clone = yield* cloneFixture(devFixtureDir, { prefix: "floci-dev-web-" });
      const serverPath = path.join(clone, "server.ts");
      const source = yield* fs.readFileString(serverPath);
      const rewrite = (marker: string) =>
        fs.writeFileString(serverPath, source.replace(`"marker-v1"`, `"${marker}"`));

      const deploy = (greeting: string) =>
        stack.deploy(
          AWS.Lambda.WebFunction("DevWeb", {
            main: serverPath,
            authType: "ApplicationManaged",
            env: { GREETING: greeting },
          }),
        );

      const fn = yield* deploy("first");
      expect(yield* getText(fn.url)).toBe("marker-v1:first");

      const swapStartedAt = Date.now();
      yield* rewrite("marker-v2");
      expect(yield* waitForText(fn.url, (body) => body === "marker-v2:first")).toBe(
        "marker-v2:first",
      );
      yield* Effect.log(`hot reload observed at the endpoint in ${Date.now() - swapStartedAt}ms`);

      // An engine reconcile (an env change) publishes a revision of its own.
      // The next swap must copy that revision, or the env would revert.
      const updated = yield* deploy("second");
      expect(updated.url).toBe(fn.url);
      expect(yield* waitForText(fn.url, (body) => body === "marker-v2:second")).toBe(
        "marker-v2:second",
      );

      yield* rewrite("marker-v3");
      expect(yield* waitForText(fn.url, (body) => body === "marker-v3:second")).toBe(
        "marker-v3:second",
      );

      yield* stack.destroy();
      expect(yield* webFunctionExists(fn.functionName)).toBe(false);
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "local"], timeout: 300_000 },
);

test.provider(
  "dev hot-swaps a prebuilt (bundle: false) Web Function without a deploy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const clone = yield* cloneFixture(prebuiltDir, { prefix: "floci-dev-web-prebuilt-" });
      const fn = yield* stack.deploy(
        AWS.Lambda.WebFunction("DevPrebuiltWeb", {
          main: path.join(clone, "server.mjs"),
          bundle: false,
          authType: "ApplicationManaged",
        }),
      );
      expect(yield* getText(fn.url)).toMatch(/^prebuilt on /);

      yield* fs.writeFileString(
        path.join(clone, "greeting.mjs"),
        `export const greeting = "prebuilt-v2";\n`,
      );
      expect(yield* waitForText(fn.url, (body) => body.startsWith("prebuilt-v2 on "))).toMatch(
        /^prebuilt-v2 on /,
      );

      yield* stack.destroy();
      expect(yield* webFunctionExists(fn.functionName)).toBe(false);
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "local"], timeout: 300_000 },
);
