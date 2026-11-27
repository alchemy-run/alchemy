import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import * as STS from "@distilled.cloud/aws/sts";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:lambda", "live"];
const runtimeContext = fileURLToPath(new URL("./fixtures/custom-runtime", import.meta.url));
const handlerPath = fileURLToPath(new URL("./fixtures/runtime-handler.ts", import.meta.url));

const Marker = Schema.Struct({ marker: Schema.String });

class WrongMarker extends Data.TaggedError("WrongMarker")<{ message: string }> {}

/**
 * Invoke the function until it reports `marker`. Warm execution environments
 * keep the runtime version they started on, so a rollout shows up as new
 * environments start.
 */
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
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
  );

test.provider(
  "publish a runtime, run a function on it, roll out a new version, and restore it after destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Lambda reserves a deleted runtime's name for at least 7 days and
      // counts it toward the 100-runtime quota, so each stage reuses one name
      // and the provider restores it.
      const runtimeName = `alchemy-cmr-${stack.stage}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
      const { Account: accountId } = yield* STS.getCallerIdentity({});

      const program = (options: {
        marker: string;
        onAlias: boolean;
        description?: string;
        /** Aliases the runtime's resource policy lets this account use. */
        share?: string[];
      }) =>
        Effect.gen(function* () {
          const runtime = yield* AWS.Lambda.Runtime("Node", {
            name: runtimeName,
            description: options.description,
            licenseInfo: "MIT",
            recoveryWindowInDays: 7,
          });
          if (options.share) {
            yield* AWS.Lambda.ResourcePolicy("NodeSharing", {
              resourceArn: runtime.runtimeArn,
              policyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "AllowAccountToUseRuntime",
                    Effect: "Allow",
                    Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                    Action: ["lambda:AssociateRuntimeAlias"],
                    Resource: options.share.map(
                      (alias) => Output.interpolate`${runtime.runtimeArn}/alias/${alias}`,
                    ),
                  },
                ],
              },
            });
          }
          const version = yield* AWS.Lambda.RuntimeVersion("NodeVersion", {
            runtime,
            context: runtimeContext,
            buildArgs: { MARKER: options.marker },
            releaseNotes: `marker ${options.marker}`,
            recoveryWindowInDays: 7,
          });
          const alias = yield* AWS.Lambda.RuntimeAlias("NodeProd", {
            version,
            name: "prod",
            description: "Production",
            recoveryWindowInDays: 7,
          });
          const fn = yield* AWS.Lambda.Function("OnRuntime", {
            main: handlerPath,
            functionUrl: false,
            runtime: options.onAlias ? alias : "nodejs24.x",
            // A new value starts new execution environments, which pick up
            // the alias's current version.
            env: { RELEASE: options.marker },
          });
          return { runtime, version, alias, fn };
        });

      // A function on a Lambda-managed runtime, beside a freshly published
      // runtime.
      const managed = yield* stack.deploy(program({ marker: "v1", onAlias: false }));
      expect(managed.runtime.runtimeName).toBe(runtimeName);
      expect(managed.alias.aliasName).toBe("prod");
      expect(managed.alias.versionName).toBe(managed.version.versionName);
      expect(managed.version.architectures).toEqual(["x86_64"]);
      const observedRuntime = yield* lambdacore.getRuntime({ RuntimeName: runtimeName });
      expect(observedRuntime.State).toBe("ACTIVE");
      expect(observedRuntime.LicenseInfo).toBe("MIT");
      const runtimeTags = yield* Lambda.listTags({ Resource: observedRuntime.Arn });
      expect(runtimeTags.Tags?.["alchemy::id"]).toBe("Node");
      expect(yield* invokeUntil(managed.fn.functionName, "none")).toBe("none");

      // Switching the function onto the alias updates it in place.
      const switchPlan = yield* stack.plan(program({ marker: "v1", onAlias: true }));
      expect(switchPlan.resources.OnRuntime?.action).toBe("update");
      const onAlias = yield* stack.deploy(program({ marker: "v1", onAlias: true }));
      expect(onAlias.fn.functionArn).toBe(managed.fn.functionArn);
      const config = yield* Lambda.getFunctionConfiguration({
        FunctionName: onAlias.fn.functionName,
      });
      expect(config.Runtime).toBe("custom");
      expect(config.RuntimeConfig).toEqual({
        RuntimeArn: observedRuntime.Arn,
        RuntimeAlias: "prod",
      });
      expect(yield* invokeUntil(onAlias.fn.functionName, "v1")).toBe("v1");

      // Redeploying unchanged is a no-op for every runtime resource.
      const unchanged = yield* stack.plan(program({ marker: "v1", onAlias: true }));
      expect(unchanged.resources.Node?.action).toBe("noop");
      expect(unchanged.resources.NodeVersion?.action).toBe("noop");
      expect(unchanged.resources.NodeProd?.action).toBe("noop");

      // A new image is a new version; the alias moves to it and the function
      // picks it up without changing its runtime config.
      const rollout = yield* stack.deploy(program({ marker: "v2", onAlias: true }));
      expect(rollout.version.versionName).not.toBe(onAlias.version.versionName);
      expect(rollout.alias.aliasArn).toBe(onAlias.alias.aliasArn);
      const observedAlias = yield* lambdacore.getRuntimeAlias({
        RuntimeName: runtimeName,
        Name: "prod",
      });
      expect(observedAlias.RuntimeVersion).toBe(rollout.version.versionName);
      const oldVersion = yield* lambdacore.getRuntimeVersion({
        RuntimeName: runtimeName,
        Name: onAlias.version.versionName,
      });
      expect(oldVersion.State).toBe("PENDING_DELETION");
      expect(yield* invokeUntil(rollout.fn.functionName, "v2")).toBe("v2");

      // A ResourcePolicy writes the runtime's resource-based policy, a
      // change updates it in place, and removing it deletes the policy.
      yield* stack.deploy(
        program({ marker: "v2", onAlias: true, description: "Shared", share: ["*"] }),
      );
      const policy = yield* Lambda.getResourcePolicy({ ResourceArn: observedRuntime.Arn });
      expect(policy.Policy).toContain("lambda:AssociateRuntimeAlias");
      expect(policy.Policy).toContain(`arn:aws:iam::${accountId}:root`);
      expect(policy.Policy).toContain(`${observedRuntime.Arn}/alias/*`);
      expect((yield* lambdacore.getRuntime({ RuntimeName: runtimeName })).Description).toBe(
        "Shared",
      );
      yield* stack.deploy(
        program({ marker: "v2", onAlias: true, description: "Shared", share: ["prod"] }),
      );
      const narrowed = yield* Lambda.getResourcePolicy({ ResourceArn: observedRuntime.Arn });
      expect(narrowed.Policy).toContain(`${observedRuntime.Arn}/alias/prod`);
      expect(narrowed.Policy).not.toContain(`${observedRuntime.Arn}/alias/*`);
      expect(narrowed.RevisionId).not.toBe(policy.RevisionId);
      yield* stack.deploy(program({ marker: "v2", onAlias: true }));
      const noPolicy = yield* Lambda.getResourcePolicy({ ResourceArn: observedRuntime.Arn }).pipe(
        Effect.map(() => "present"),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed("absent")),
      );
      expect(noPolicy).toBe("absent");

      // Destroy schedules every runtime resource for deletion.
      yield* stack.destroy();
      expect((yield* lambdacore.getRuntime({ RuntimeName: runtimeName })).State).toBe(
        "PENDING_DELETION",
      );
      expect(
        (yield* lambdacore.getRuntimeAlias({ RuntimeName: runtimeName, Name: "prod" })).State,
      ).toBe("PENDING_DELETION");

      // Deploying again within the window restores the runtime and the
      // `prod` alias under their reserved names.
      const restored = yield* stack.deploy(program({ marker: "v1", onAlias: true }));
      expect(restored.runtime.runtimeArn).toBe(observedRuntime.Arn);
      expect((yield* lambdacore.getRuntime({ RuntimeName: runtimeName })).State).toBe("ACTIVE");
      const restoredAlias = yield* lambdacore.getRuntimeAlias({
        RuntimeName: runtimeName,
        Name: "prod",
      });
      expect(restoredAlias.State).toBe("ACTIVE");
      expect(restoredAlias.RuntimeVersion).toBe(restored.version.versionName);
      expect(yield* invokeUntil(restored.fn.functionName, "v1")).toBe("v1");

      yield* stack.destroy();
      expect((yield* lambdacore.getRuntime({ RuntimeName: runtimeName })).State).toBe(
        "PENDING_DELETION",
      );
    }),
  { tags, timeout: 900_000 },
);
