import { Action } from "@/Action";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/fly-io";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasFlyCreds = !!process.env.FLY_API_TOKEN;

const VALUE_A = Redacted.make("alchemy-binding-a");
const VALUE_B = Redacted.make("alchemy-binding-b");
const CREATED_NAME = "BINDING_CREATED";

const waitUntilGone = (appName: string, secretName: string) =>
  Services.machines
    .secretGet({
      app_name: appName,
      secret_name: secretName,
      show_secrets: false,
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

test.provider.skipIf(!hasFlyCreds)(
  "ReadWriteSecret: get, list, create, update and delete an app secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const secret = yield* Fly.Secret("DbUrl", {
            app,
            value: VALUE_A,
          });

          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const secretName = yield* secret.name;
              const secrets = yield* Fly.ReadWriteSecret(secret);
              return Effect.fn(function* () {
                const listed = yield* secrets.list();
                const got = yield* secrets.get();

                yield* secrets.create(CREATED_NAME, VALUE_A);
                const created = yield* secrets.get(CREATED_NAME);

                yield* secrets.update(CREATED_NAME, VALUE_B);
                const updated = yield* secrets.get(CREATED_NAME);

                yield* secrets.delete(CREATED_NAME);

                return {
                  secretName,
                  listedNames: (listed.secrets ?? []).flatMap((row) =>
                    row.name === undefined ? [] : [row.name],
                  ),
                  gotName: got.name,
                  gotDigest: got.digest,
                  createdName: created.name,
                  createdDigest: created.digest,
                  updatedDigest: updated.digest,
                };
              });
            }).pipe(Effect.provide(Fly.ReadWriteSecretHttp)),
          );

          return {
            app,
            secret,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.gotName).toEqual(out.secret.name);
      expect(out.probe.gotDigest).toEqual(expect.any(String));
      expect(out.probe.listedNames).toContain(out.secret.name);
      expect(out.probe.createdName).toEqual(CREATED_NAME);
      expect(out.probe.createdDigest).toEqual(expect.any(String));
      expect(out.probe.updatedDigest).toEqual(expect.any(String));
      expect(out.probe.updatedDigest).not.toEqual(out.probe.createdDigest);

      const fetched = yield* Services.machines.secretGet({
        app_name: out.secret.appName,
        secret_name: out.secret.name,
        show_secrets: false,
      });
      expect(fetched.name).toEqual(out.secret.name);
      expect(fetched.value).toBeUndefined();

      const createdGone = yield* Services.machines
        .secretGet({
          app_name: out.secret.appName,
          secret_name: CREATED_NAME,
          show_secrets: false,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(createdGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(out.secret.appName, out.secret.name);
      expect(gone).toEqual("gone");
      const appGone = yield* waitAppGone(out.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
