import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const sqlInstance =
  process.env.GCP_SQL_INSTANCE || process.env.GCP_TEST_SQL_INSTANCE;
const runLifecycle = hasGcpCreds && !!sqlInstance && !process.env.FAST;

const waitUntilGone = (instance: string, sha1Fingerprint: string) =>
  sqladmin
    .getSslCerts({
      project,
      instance,
      sha1Fingerprint,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getSslCerts on a missing instance fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getSslCerts({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          sha1Fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      );
      // Cloud SQL hides unknown instances behind 403 rather than 404.
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "lists sql ssl certs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const page = yield* sqladmin.listInstances({
        project,
        maxResults: 10,
      });
      expect(Array.isArray(page.items ?? [])).toEqual(true);
      for (const instance of page.items ?? []) {
        if (!instance.name) continue;
        const certs = yield* sqladmin
          .listSslCerts({
            project,
            instance: instance.name,
          })
          .pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed({ items: [] as sqladmin.SslCertList }),
            ),
          );
        expect(Array.isArray(certs.items ?? [])).toEqual(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete a sql ssl cert",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = sqlInstance!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.SslCert("Client", {
            instance,
          });
        }),
      );

      expect(created.commonName).toEqual(expect.any(String));
      expect(created.commonName.length).toBeGreaterThan(0);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      expect(created.sha1Fingerprint).toMatch(/^[a-fA-F0-9]{40}$/);
      expect(created.cert).toEqual(
        expect.stringContaining("BEGIN CERTIFICATE"),
      );
      expect(created.privateKey).toEqual(expect.stringContaining("BEGIN"));
      expect(created.serverCaCert).toEqual(
        expect.stringContaining("BEGIN CERTIFICATE"),
      );

      const fetched = yield* sqladmin.getSslCerts({
        project: created.project,
        instance: created.instance,
        sha1Fingerprint: created.sha1Fingerprint,
      });
      expect(fetched.commonName).toEqual(created.commonName);
      expect(fetched.sha1Fingerprint).toEqual(created.sha1Fingerprint);
      expect(fetched.cert).toEqual(
        expect.stringContaining("BEGIN CERTIFICATE"),
      );

      const unchanged = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.SslCert("Client", {
            instance,
            commonName: created.commonName,
          });
        }),
      );
      expect(unchanged.sha1Fingerprint).toEqual(created.sha1Fingerprint);
      expect(unchanged.privateKey).toEqual(created.privateKey);
      expect(unchanged.serverCaCert).toEqual(created.serverCaCert);

      const nextName =
        created.commonName.length >= 64
          ? `${created.commonName.slice(0, 63)}b`
          : `${created.commonName}b`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.SslCert("Client", {
            instance,
            commonName: nextName,
          });
        }),
      );

      expect(replaced.commonName).toEqual(nextName);
      expect(replaced.sha1Fingerprint).not.toEqual(created.sha1Fingerprint);
      expect(replaced.privateKey).toEqual(expect.stringContaining("BEGIN"));

      const refetched = yield* sqladmin.getSslCerts({
        project: replaced.project,
        instance: replaced.instance,
        sha1Fingerprint: replaced.sha1Fingerprint,
      });
      expect(refetched.commonName).toEqual(nextName);

      const oldGone = yield* waitUntilGone(
        created.instance,
        created.sha1Fingerprint,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.instance,
        replaced.sha1Fingerprint,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
