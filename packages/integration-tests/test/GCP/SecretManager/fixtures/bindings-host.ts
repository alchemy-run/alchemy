import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { recordAuditLogs } from "../../auditLogs.ts";
import { outcome, serveProbes } from "../../bindingHost.ts";

/** Secret the per-operation AddSecretVersion / AccessSecretVersion bind. */
export const OpsSecret = GCP.SecretManager.Secret("OpsSecret", {});

/** Regional secret the per-operation bindings bind. */
export const RegionalSecret = GCP.SecretManager.LocationsSecret("RegionalSecret", {
  location: "us-central1",
});

/** Secret only {@link GCP.SecretManager.ReadSecret} binds (seeded by the test). */
export const ReadOnlySecret = GCP.SecretManager.Secret("ReadOnlySecret", {});

/** Secret only {@link GCP.SecretManager.WriteSecret} binds. */
export const WriteOnlySecret = GCP.SecretManager.Secret("WriteOnlySecret", {});

/** Secret only {@link GCP.SecretManager.ReadWriteSecret} binds. */
export const ReadWriteOnlySecret = GCP.SecretManager.Secret("ReadWriteOnlySecret", {});

/** Secrets the generated bindings bind (versions seeded by the test). */
export const GenSecret = GCP.SecretManager.Secret("GenSecret", {});
export const GenRegionalSecret = GCP.SecretManager.LocationsSecret("GenRegionalSecret", {
  location: "us-central1",
});

/** Payload the test seeds into {@link ReadOnlySecret}. */
export const SEEDED = "seeded-value";

/**
 * Effect-native Cloud Run service exercising every Secret Manager binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */

/** Bucket the audit-log consumers record entries in. */
export const AuditMarkers = GCP.Storage.Bucket("AuditMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

export default class SecretManagerBindingsHost extends GCP.Function<SecretManagerBindingsHost>()(
  "SecretManagerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* GCP.SecretManager.consumeSecretAuditLogs(
      GenSecret,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("secret", putMarker),
    );
    yield* GCP.SecretManager.consumeLocationsSecretAuditLogs(
      GenRegionalSecret,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("locationsSecret", putMarker),
    );
    const addVersion = yield* GCP.SecretManager.AddSecretVersion(OpsSecret);
    const access = yield* GCP.SecretManager.AccessSecretVersion(OpsSecret);
    const addRegional = yield* GCP.SecretManager.AddSecretVersion(RegionalSecret);
    const accessRegional = yield* GCP.SecretManager.AccessSecretVersion(RegionalSecret);
    const reader = yield* GCP.SecretManager.ReadSecret(ReadOnlySecret);
    const writer = yield* GCP.SecretManager.WriteSecret(WriteOnlySecret);
    const both = yield* GCP.SecretManager.ReadWriteSecret(ReadWriteOnlySecret);
    const getSecret = yield* GCP.SecretManager.GetSecret(GenSecret);
    const getRegional = yield* GCP.SecretManager.GetSecret(GenRegionalSecret);
    const listVersions = yield* GCP.SecretManager.ListSecretVersions(GenSecret);
    const listRegionalVersions = yield* GCP.SecretManager.ListSecretVersions(GenRegionalSecret);
    const getVersion = yield* GCP.SecretManager.GetSecretVersion(GenSecret);
    const enableVersion = yield* GCP.SecretManager.EnableSecretVersion(GenSecret);
    const rotate = yield* GCP.SecretManager.RotateSecret(GenSecret);
    const enableRotation = yield* GCP.SecretManager.EnableSecretManagedRotation(GenSecret);
    const listSecrets = yield* GCP.SecretManager.ListSecrets();

    const roundTrip = (add: typeof addVersion, read: typeof access, value: string) =>
      Effect.gen(function* () {
        const payload = btoa(value);
        const version = yield* add({ payload: { data: payload } });
        const accessed = yield* read({
          version: version.name?.split("/").pop(),
        });
        return {
          version: version.name,
          accessedName: accessed.name,
          data: accessed.payload?.data,
          payload,
        };
      });

    return {
      fetch: serveProbes({
        listSecrets: Effect.gen(function* () {
          const global = yield* listSecrets({ pageSize: 25000 });
          const regional = yield* listSecrets({ location: "us-central1", pageSize: 25000 });
          return {
            global: (global.secrets ?? []).map((secret) => secret.name),
            regional: (regional.secrets ?? []).map((secret) => secret.name),
          };
        }),
        ops: roundTrip(addVersion, access, "per-op-global"),
        opsRegional: roundTrip(addRegional, accessRegional, "per-op-regional"),
        getSecret: Effect.all({ global: getSecret(), regional: getRegional() }),
        listSecretVersions: Effect.all({
          global: listVersions(),
          regional: listRegionalVersions(),
        }),
        getSecretVersion: getVersion({ version: "1" }),
        enableSecretVersion: enableVersion({ version: "1" }),
        // Managed rotation needs a Cloud SQL secret; on a plain secret the
        // call is authorized and rejected as a bad request.
        managedRotation: Effect.all({
          rotate: outcome(rotate()),
          enable: outcome(enableRotation()),
        }),
        read: Effect.gen(function* () {
          const latest = yield* reader.access();
          const bytes = yield* reader.accessBytes("latest");
          const missing = yield* reader.access("999");
          return {
            latest,
            bytes: bytes && new TextDecoder().decode(bytes),
            missing: missing === undefined,
          };
        }),
        write: Effect.gen(function* () {
          const v1 = yield* writer.addVersion("one");
          const v2 = yield* writer.addVersion(new TextEncoder().encode("two"));
          yield* writer.disableVersion(v2);
          yield* writer.destroyVersion(v1.split("/").pop() ?? v1);
          yield* writer.destroyVersion("999");
          return { v1, v2 };
        }),
        readWrite: Effect.gen(function* () {
          const v1 = yield* both.addVersion("one");
          const v2 = yield* both.addVersion(new TextEncoder().encode("two"));
          const latest = yield* both.access();
          const first = yield* both.accessBytes(v1);
          yield* both.disableVersion(v2);
          const disabled = yield* Effect.result(both.access(v2));
          yield* both.destroyVersion(v1);
          const destroyed = yield* both.access(v1);
          return {
            v1,
            v2,
            latest,
            first: first && new TextDecoder().decode(first),
            disabledReadsUndefined: Result.isSuccess(disabled) && disabled.success === undefined,
            destroyedReadsUndefined: destroyed === undefined,
          };
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.SecretManager.AddSecretVersionHttp),
    Effect.provide(GCP.SecretManager.AccessSecretVersionHttp),
    Effect.provide(GCP.SecretManager.ReadSecretHttp),
    Effect.provide(GCP.SecretManager.WriteSecretHttp),
    Effect.provide(GCP.SecretManager.ReadWriteSecretHttp),
    Effect.provide(
      Layer.mergeAll(
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
        GCP.SecretManager.GetSecretHttp,
        GCP.SecretManager.ListSecretVersionsHttp,
        GCP.SecretManager.GetSecretVersionHttp,
        GCP.SecretManager.EnableSecretVersionHttp,
        GCP.SecretManager.RotateSecretHttp,
        GCP.SecretManager.EnableSecretManagedRotationHttp,
        GCP.SecretManager.ListSecretsHttp,
      ),
    ),
  ),
) {}
