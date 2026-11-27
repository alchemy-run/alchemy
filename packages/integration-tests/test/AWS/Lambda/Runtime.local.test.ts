/**
 * `AWS.Lambda.Runtime`, `RuntimeVersion` and `RuntimeAlias` under `alchemy
 * dev`: the dualized providers publish the runtime into the floci emulator,
 * the version's image is built and pushed to floci's ECR, and a dev Function
 * on the alias runs its .zip code in that image.
 *
 * Proof structure:
 *   - the runtime's resource policy is stored in floci;
 *   - attrs carry the emulator account (`:000000000000:`), which the live
 *     cloud can never produce;
 *   - the function reports the marker file the version's image writes, so
 *     it ran in the customer-managed runtime, not a managed one;
 *   - a new image replaces the version, the alias moves to it, and the
 *     function's next execution environment reports the new marker;
 *   - after destroy floci reports the runtime pending deletion;
 *   - `Alchemy.remote()` publishes the same runtime chain to real AWS in a
 *     dev run, and destroy schedules it for deletion there.
 */
import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as Region from "@alchemy.run/aws/Region";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { liveContext } from "../Local/fixtures/live.ts";
import { FLOCI_ENDPOINT } from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const runtimeContext = fileURLToPath(new URL("./fixtures/custom-runtime", import.meta.url));
const handlerPath = fileURLToPath(new URL("./fixtures/runtime-handler.ts", import.meta.url));

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

const Marker = Schema.Struct({ marker: Schema.String });

class WrongMarker extends Data.TaggedError("WrongMarker")<{ message: string }> {}

/** Invoke the emulated function until it reports `marker`. */
const invokeUntil = (functionName: string, marker: string) =>
  Effect.gen(function* () {
    const response = yield* Lambda.invoke({ FunctionName: functionName, Payload: "{}" });
    const payload = response.Payload
      ? yield* response.Payload.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.mapError((cause) => new WrongMarker({ message: String(cause) })),
        )
      : "";
    if (response.FunctionError) {
      return yield* new WrongMarker({ message: `${response.FunctionError}: ${payload}` });
    }
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Marker))(payload);
    if (body.marker !== marker) {
      return yield* new WrongMarker({ message: `served ${body.marker}` });
    }
    return body.marker;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "WrongMarker" || e._tag === "ResourceConflictException",
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
    Effect.provide(flociContext),
  );

test.provider(
  "dev publishes a runtime into floci and runs a function on it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (marker: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const runtime = yield* AWS.Lambda.Runtime("LocalNode", { recoveryWindowInDays: 7 });
            yield* AWS.Lambda.ResourcePolicy("LocalNodeSharing", {
              resourceArn: runtime.runtimeArn,
              policyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { AWS: "arn:aws:iam::111122223333:root" },
                    Action: ["lambda:AssociateRuntimeAlias"],
                    Resource: Output.interpolate`${runtime.runtimeArn}/alias/prod`,
                  },
                ],
              },
            });
            const version = yield* AWS.Lambda.RuntimeVersion("LocalNodeVersion", {
              runtime,
              context: runtimeContext,
              buildArgs: { MARKER: marker },
              recoveryWindowInDays: 7,
            });
            const alias = yield* AWS.Lambda.RuntimeAlias("LocalNodeProd", {
              version,
              name: "prod",
              recoveryWindowInDays: 7,
            });
            const fn = yield* AWS.Lambda.Function("LocalOnRuntime", {
              main: handlerPath,
              functionUrl: false,
              runtime: alias,
              env: { RELEASE: marker },
            });
            return { runtime, version, alias, fn };
          }),
        );

      const created = yield* deploy("v1");
      // The emulator's account, so no AWS call created it.
      expect(created.runtime.runtimeArn).toContain(":000000000000:");
      expect(created.alias.versionName).toBe(created.version.versionName);
      // The runtime's policy landed in floci, not the live account.
      const policy = yield* Lambda.getResourcePolicy({
        ResourceArn: created.runtime.runtimeArn,
      }).pipe(Effect.provide(flociContext));
      expect(policy.Policy).toContain(`${created.runtime.runtimeArn}/alias/prod`);
      const config = yield* Lambda.getFunctionConfiguration({
        FunctionName: created.fn.functionName,
      }).pipe(Effect.provide(flociContext));
      expect(config.Runtime).toBe("custom");
      expect(config.RuntimeConfig).toEqual({
        RuntimeArn: created.runtime.runtimeArn,
        RuntimeAlias: "prod",
      });
      expect(yield* invokeUntil(created.fn.functionName, "v1")).toBe("v1");

      // A new image is a new version; the alias moves and the function's
      // next execution environment runs it.
      const rolled = yield* deploy("v2");
      expect(rolled.version.versionName).not.toBe(created.version.versionName);
      expect(rolled.alias.versionName).toBe(rolled.version.versionName);
      expect(yield* invokeUntil(rolled.fn.functionName, "v2")).toBe("v2");

      yield* stack.destroy();
      const runtime = yield* lambdacore
        .getRuntime({ RuntimeName: created.runtime.runtimeName })
        .pipe(Effect.provide(flociContext));
      expect(runtime.State).toBe("PENDING_DELETION");
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "local"], timeout: 300_000 },
);

test.provider(
  "Alchemy.remote() publishes the runtime to real AWS in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A deleted runtime's name stays reserved for a week, so the stage
      // reuses one name and the provider restores it.
      const runtimeName = `alchemy-cmr-remote-${stack.stage}`
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "-");

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const runtime = yield* AWS.Lambda.Runtime("RemoteNode", {
            name: runtimeName,
            recoveryWindowInDays: 7,
          }).pipe(Alchemy.remote());
          const version = yield* AWS.Lambda.RuntimeVersion("RemoteNodeVersion", {
            runtime,
            context: runtimeContext,
            recoveryWindowInDays: 7,
          }).pipe(Alchemy.remote());
          const alias = yield* AWS.Lambda.RuntimeAlias("RemoteNodeProd", {
            version,
            name: "prod",
            recoveryWindowInDays: 7,
          }).pipe(Alchemy.remote());
          return { runtime, version, alias };
        }),
      );

      // A real account, not the emulator's.
      expect(outputs.runtime.runtimeArn).not.toContain(":000000000000:");
      const live = yield* lambdacore
        .getRuntimeAlias({ RuntimeName: runtimeName, Name: "prod" })
        .pipe(Effect.provide(liveContext));
      expect(live.State).toBe("ACTIVE");
      expect(live.RuntimeVersion).toBe(outputs.version.versionName);

      yield* stack.destroy();
      const gone = yield* lambdacore
        .getRuntime({ RuntimeName: runtimeName })
        .pipe(Effect.provide(liveContext));
      expect(gone.State).toBe("PENDING_DELETION");
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 300_000 },
);
