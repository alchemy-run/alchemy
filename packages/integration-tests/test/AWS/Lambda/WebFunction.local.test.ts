/**
 * `AWS.Lambda.WebFunction` under `alchemy dev`: the dualized provider deploys
 * the function, its revision and its endpoint into the floci emulator, which
 * serves the endpoint's URL from the host. `AWS.Website.*` sites do not reach
 * this path in dev; they run their framework's dev server instead.
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
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { FLOCI_ENDPOINT } from "../Local/fixtures/raw.ts";

const main = fileURLToPath(new URL("./fixtures/web/async-server.ts", import.meta.url));

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
