import { Action } from "@/Action";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/fly-io";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasFlyCreds = !!process.env.FLY_API_TOKEN;
const hasKmsCrypto = !!process.env.FLY_TEST_KMS;

const PLAINTEXT = new TextEncoder().encode("alchemy-secretkey-binding");

const waitUntilGone = (appName: string, secretName: string) =>
  Services.machines
    .secretkeyGet({
      app_name: appName,
      secret_name: secretName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitAppGone = (appName: string) =>
  Services.machines.appsShow({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/**
 * Crypto ops (`encrypt` / `sign` / …) reject org API tokens with typed
 * `Forbidden`. Key generate/set still works. An entitled Machine token
 * (Petsem / `FLY_TEST_KMS=1`) is required for a round-trip.
 */
test.provider.skipIf(!hasFlyCreds)(
  "Encrypt from an Action is typed Forbidden without a KMS token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("Box", {
            app,
            type: "nacl_secretbox",
          });

          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const encrypt = yield* Fly.Encrypt(key);
              return Effect.fn(function* () {
                return yield* Effect.result(encrypt({ plaintext: PLAINTEXT }));
              });
            }).pipe(Effect.provide(Fly.EncryptHttp)),
          );

          return {
            app,
            key,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(Result.isFailure(out.probe)).toBe(true);
      if (Result.isFailure(out.probe)) {
        expect(out.probe.failure._tag).toEqual("Forbidden");
      }

      yield* stack.destroy();

      const keyGone = yield* waitUntilGone(out.key.appName, out.key.name);
      expect(keyGone).toEqual("gone");
      const appGone = yield* waitAppGone(out.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds || !hasKmsCrypto)(
  "Encrypt and Decrypt round-trip a nacl_secretbox key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("Box", {
            app,
            type: "nacl_secretbox",
          });

          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const encrypt = yield* Fly.Encrypt(key);
              const decrypt = yield* Fly.Decrypt(key);
              return Effect.fn(function* () {
                const { ciphertext } = yield* encrypt({
                  plaintext: PLAINTEXT,
                });
                const { plaintext } = yield* decrypt({ ciphertext });
                return {
                  ciphertextLength: ciphertext.byteLength,
                  roundTrip: Array.from(Redacted.value(plaintext)),
                };
              });
            }).pipe(
              Effect.provide(Layer.mergeAll(Fly.EncryptHttp, Fly.DecryptHttp)),
            ),
          );

          return {
            app,
            key,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.ciphertextLength).toBeGreaterThan(0);
      expect(out.probe.roundTrip).toEqual(Array.from(PLAINTEXT));

      yield* stack.destroy();

      const keyGone = yield* waitUntilGone(out.key.appName, out.key.name);
      expect(keyGone).toEqual("gone");
      const appGone = yield* waitAppGone(out.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds || !hasKmsCrypto)(
  "Sign and Verify a nacl_sign key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("Signing", {
            app,
            type: "nacl_sign",
          });

          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const sign = yield* Fly.Sign(key);
              const verify = yield* Fly.Verify(key);
              return Effect.fn(function* () {
                const { signature } = yield* sign({ plaintext: PLAINTEXT });
                const { valid } = yield* verify({
                  plaintext: PLAINTEXT,
                  signature,
                });
                return {
                  signatureLength: signature.byteLength,
                  valid,
                };
              });
            }).pipe(
              Effect.provide(Layer.mergeAll(Fly.SignHttp, Fly.VerifyHttp)),
            ),
          );

          return {
            app,
            key,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.signatureLength).toBeGreaterThan(0);
      expect(out.probe.valid).toEqual(true);

      yield* stack.destroy();

      const keyGone = yield* waitUntilGone(out.key.appName, out.key.name);
      expect(keyGone).toEqual("gone");
      const appGone = yield* waitAppGone(out.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
