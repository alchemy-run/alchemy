import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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
  "AddSecretVersion and AccessSecretVersion round-trip",
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
              const addVersion =
                yield* GCP.SecretManager.AddSecretVersion(secret);
              const access =
                yield* GCP.SecretManager.AccessSecretVersion(secret);
              return Effect.fn(function* () {
                const payload = btoa("super-secret");
                const version = yield* addVersion({
                  payload: { data: payload },
                });
                const accessed = yield* access();
                return { version, accessed, payload };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.version.name).toContain("/versions/");
      expect(out.accessed.payload?.data).toEqual(out.payload);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !process.env.GCP_TEST_REGIONAL_SECRETS || !!process.env.FAST,
)(
  "AddSecretVersion and AccessSecretVersion round-trip a regional secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const secret = yield* GCP.SecretManager.LocationsSecret("ApiKey", {
            location: "us-central1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* secret.name;
              const addVersion =
                yield* GCP.SecretManager.AddSecretVersion(secret);
              const access =
                yield* GCP.SecretManager.AccessSecretVersion(secret);
              return Effect.fn(function* () {
                const payload = btoa("super-secret-regional");
                const version = yield* addVersion({
                  payload: { data: payload },
                });
                const accessed = yield* access();
                return { version, accessed, payload };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.version.name).toContain("/locations/us-central1/secrets/");
      expect(out.version.name).toContain("/versions/");
      expect(out.accessed.payload?.data).toEqual(out.payload);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
