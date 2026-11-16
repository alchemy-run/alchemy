import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const program = (value: string) =>
  Effect.gen(function* () {
    const secret = yield* GCP.SecretManager.Secret("VersionedSecret", {});
    const version = yield* GCP.SecretManager.SecretVersion("VersionedSecretValue", {
      secret: secret.name,
      value: Redacted.make(value),
    });
    return { secret, version };
  });

const payloadOf = (name: string) =>
  secretmanager
    .accessProjectsSecretsVersions({ name })
    .pipe(
      Effect.map((response) =>
        Buffer.from(response.payload?.data ?? "", "base64").toString("utf8"),
      ),
    );

test.provider(
  "add a version only when the value changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("first-value"));
      expect(first.version.secret).toEqual(first.secret.name);
      expect(first.version.name).toEqual(`${first.secret.name}/versions/${first.version.version}`);
      expect(yield* payloadOf(first.version.name)).toEqual("first-value");

      // Same value: no new version.
      const again = yield* stack.deploy(program("first-value"));
      expect(again.version.name).toEqual(first.version.name);

      // New value: a new version, which `latest` now resolves to.
      const second = yield* stack.deploy(program("second-value"));
      expect(second.version.name).not.toEqual(first.version.name);
      expect(yield* payloadOf(`${first.secret.name}/versions/latest`)).toEqual("second-value");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
    timeout: 120_000,
  },
);
