/**
 * `AWS.Lambda.MicrovmImage` under `alchemy dev`: the dualized provider builds
 * the image in the floci emulator, and — the point of this file — a
 * CONTENT-ONLY edit of the in-VM program is a real change.
 *
 * None of the image's props change when a module in `main`'s graph is
 * edited, so an engine diff that only compares props calls the edit a noop
 * and the image is never rebuilt (on `alchemy dev` AND on `alchemy deploy`).
 * The provider's diff therefore bundles (memoized for the run) and compares
 * the artifact's build identity, the same way the Lambda Function diff does.
 *
 * Proof structure:
 *   - deploy an effectful image; its `codeArtifact.hash` is the identity of
 *     the bundled program;
 *   - re-deploy with NO change: the hash is unchanged and the image keeps
 *     its version (a true noop);
 *   - rewrite the program's marker in a clone and re-deploy the SAME
 *     declaration: the hash changes and the image advances to a new
 *     version (a rebuild — before the fix this was a noop);
 *   - destroy removes the image from the emulator.
 *
 * Requires Docker (floci builds MicroVM images as containers); skipped when
 * the daemon is unavailable.
 */
import * as AWS from "@/AWS";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { dockerAvailable, FLOCI_ENDPOINT } from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = fileURLToPath(
  new URL("./fixtures/microvm-dev", import.meta.url),
);

/** Floci-scoped context for the raw distilled calls the test makes itself. */
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

test.provider.skipIf(!dockerAvailable)(
  "a content-only edit of the in-VM program rebuilds the image; an unchanged program is a noop",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const clone = yield* cloneFixture(fixtureDir, {
        prefix: "floci-dev-microvm-",
      });
      const mainPath = path.join(clone, "program.ts");

      const declaration = Effect.gen(function* () {
        const buildRole = yield* AWS.IAM.Role("DevMicrovmBuildRole");
        return yield* AWS.Lambda.MicrovmImage("DevMicrovm", {
          main: mainPath,
          buildRole,
          runtime: "bun",
          resources: [{ minimumMemoryInMiB: 512 }],
          cpuConfigurations: [{ architecture: "ARM_64" }],
        });
      });

      const first = yield* stack.deploy(declaration);
      // Emulator identity: the live cloud never mints the dummy account.
      expect(first.imageArn).toContain(":000000000000:");
      expect(first.codeArtifact?.hash).toBeDefined();

      // Same declaration, same source — a true noop: nothing is rebuilt.
      const unchanged = yield* stack.deploy(declaration);
      expect(unchanged.codeArtifact?.hash).toBe(first.codeArtifact!.hash);
      expect(unchanged.latestActiveImageVersion).toBe(
        first.latestActiveImageVersion,
      );

      // Content-only change: no prop differs, only the bundled program.
      const source = yield* fs.readFileString(mainPath);
      yield* fs.writeFileString(
        mainPath,
        source.replace(`"microvm-marker-v1"`, `"microvm-marker-v2"`),
      );
      const rebuilt = yield* stack.deploy(declaration);
      expect(rebuilt.imageArn).toBe(first.imageArn);
      expect(rebuilt.codeArtifact?.hash).not.toBe(first.codeArtifact!.hash);
      expect(rebuilt.latestActiveImageVersion).not.toBe(
        first.latestActiveImageVersion,
      );

      // Destroy: the image must be gone from the emulator.
      yield* stack.destroy();
      const gone = yield* microvms
        .getMicrovmImage({ imageIdentifier: first.imageArn })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.provide(flociContext),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (isGone): boolean => isGone,
            times: 20,
          }),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 600_000 },
);
