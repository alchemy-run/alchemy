import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test.provider.skipIf(!hasGcpCreds)(
  "ReadSecret, WriteSecret, and ReadWriteSecret clients",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const secret = yield* GCP.SecretManager.Secret("ApiKey", {});
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* secret.name;
              const reader = yield* GCP.SecretManager.ReadSecret(secret);
              const writer = yield* GCP.SecretManager.WriteSecret(secret);
              const both = yield* GCP.SecretManager.ReadWriteSecret(secret);
              return Effect.fn(function* () {
                const empty = yield* reader.access();
                const v1 = yield* writer.addVersion("one");
                const v2 = yield* both.addVersion(
                  new TextEncoder().encode("two"),
                );
                const latest = yield* reader.access();
                const first = yield* both.accessBytes(v1);
                yield* writer.disableVersion(v2);
                const pinned = yield* reader.access(v1.split("/").pop());
                const disabled = yield* Effect.result(reader.access(v2));
                yield* both.destroyVersion(v2);
                yield* writer.destroyVersion(v1);
                yield* writer.destroyVersion("999");
                const missing = yield* both.access("999");
                return {
                  empty: empty === undefined,
                  versions: [v1, v2].every((v) => v.includes("/versions/")),
                  latest,
                  first: first && new TextDecoder().decode(first),
                  pinned,
                  disabled: Result.isFailure(disabled)
                    ? disabled.failure._tag
                    : disabled.success,
                  missing: missing === undefined,
                };
              });
            }).pipe(
              Effect.provide(GCP.SecretManager.ReadSecretHttp),
              Effect.provide(GCP.SecretManager.WriteSecretHttp),
              Effect.provide(GCP.SecretManager.ReadWriteSecretHttp),
            ),
          );
          return { probe: yield* Probe({}) };
        }),
      );

      expect(out.probe).toEqual({
        empty: true,
        versions: true,
        latest: "two",
        first: "one",
        pinned: "one",
        disabled: undefined,
        missing: true,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
