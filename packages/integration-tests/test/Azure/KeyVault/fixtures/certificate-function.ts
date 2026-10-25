import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { distilledFromSource } from "./distilled-source.ts";

// The vault every certificate binding binds to. Module-scope so the test
// stack yields the same declaration.
export const Vault = Azure.KeyVault.Vault("KvCertsVault", { softDeleteRetentionInDays: 7 });

type Failure = { readonly _tag: string; readonly message?: string };
type Route = (body: unknown) => Effect.Effect<unknown, Failure, RuntimeContext>;

/** Expose a binding callable as a route taking its request as the JSON body. */
const route =
  <R>(call: (request: R) => Effect.Effect<unknown, Failure, RuntimeContext>): Route =>
  (body) =>
    // The JSON body is the binding's request.
    call(body as R);

/**
 * Answer `{ ok: true, result }`, or `{ ok: false, tag, error }` with a 500
 * so callers retry through role propagation and assert typed failures.
 */
const respond = (effect: Effect.Effect<unknown, Failure, RuntimeContext>) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true, result: result ?? null })),
    Effect.catch((error) =>
      Effect.succeed({ ok: false, tag: error._tag, error: error.message ?? error._tag }),
    ),
    Effect.flatMap((body) => HttpServerResponse.json(body, { status: body.ok ? 200 : 500 })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const selfSigned = (name: string) => ({
  issuer: { name: "Self" },
  x509_props: { subject: `CN=${name}`, validity_months: 12 },
  key_props: { kty: "RSA", key_size: 2048, exportable: true, reuse_key: false },
  secret_props: { contentType: "application/x-pkcs12" },
});

/**
 * Effect-native Azure Function exercising every Key Vault certificate
 * binding on a managed-identity host. `POST /call/<route>` calls one binding
 * with the JSON body as its request.
 */
export default class KvCertificatesFunction extends Azure.Functions.Function<KvCertificatesFunction>()(
  "KvCertificatesFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const vault = yield* Vault;

    const read = yield* Azure.KeyVault.CertificateRead(vault);
    const write = yield* Azure.KeyVault.CertificateWrite(vault);
    const readWrite = yield* Azure.KeyVault.CertificateReadWrite(vault);

    const getCertificate = yield* Azure.KeyVault.GetCertificate(vault);
    const getCertificates = yield* Azure.KeyVault.GetCertificates(vault);
    const getCertificateVersions = yield* Azure.KeyVault.GetCertificateVersions(vault);
    const getCertificatePolicy = yield* Azure.KeyVault.GetCertificatePolicy(vault);
    const getCertificateOperation = yield* Azure.KeyVault.GetCertificateOperation(vault);
    const getDeletedCertificate = yield* Azure.KeyVault.GetDeletedCertificate(vault);
    const getDeletedCertificates = yield* Azure.KeyVault.GetDeletedCertificates(vault);
    const createCertificate = yield* Azure.KeyVault.CreateCertificate(vault);
    const mergeCertificate = yield* Azure.KeyVault.MergeCertificate(vault);
    const importCertificate = yield* Azure.KeyVault.ImportCertificate(vault);
    const updateCertificate = yield* Azure.KeyVault.UpdateCertificate(vault);
    const updateCertificatePolicy = yield* Azure.KeyVault.UpdateCertificatePolicy(vault);
    const updateCertificateOperation = yield* Azure.KeyVault.UpdateCertificateOperation(vault);
    const deleteCertificateOperation = yield* Azure.KeyVault.DeleteCertificateOperation(vault);
    const deleteCertificate = yield* Azure.KeyVault.DeleteCertificate(vault);
    const backupCertificate = yield* Azure.KeyVault.BackupCertificate(vault);
    const restoreCertificate = yield* Azure.KeyVault.RestoreCertificate(vault);
    const recoverDeletedCertificate = yield* Azure.KeyVault.RecoverDeletedCertificate(vault);
    const purgeDeletedCertificate = yield* Azure.KeyVault.PurgeDeletedCertificate(vault);
    const getCertificateIssuer = yield* Azure.KeyVault.GetCertificateIssuer(vault);
    const getCertificateIssuers = yield* Azure.KeyVault.GetCertificateIssuers(vault);
    const setCertificateIssuer = yield* Azure.KeyVault.SetCertificateIssuer(vault);
    const updateCertificateIssuer = yield* Azure.KeyVault.UpdateCertificateIssuer(vault);
    const deleteCertificateIssuer = yield* Azure.KeyVault.DeleteCertificateIssuer(vault);
    const getCertificateContacts = yield* Azure.KeyVault.GetCertificateContacts(vault);
    const setCertificateContacts = yield* Azure.KeyVault.SetCertificateContacts(vault);
    const deleteCertificateContacts = yield* Azure.KeyVault.DeleteCertificateContacts(vault);

    const routes: Record<string, Route> = {
      GetCertificate: route(getCertificate),
      GetCertificates: route(getCertificates),
      GetCertificateVersions: route(getCertificateVersions),
      GetCertificatePolicy: route(getCertificatePolicy),
      GetCertificateOperation: route(getCertificateOperation),
      GetDeletedCertificate: route(getDeletedCertificate),
      GetDeletedCertificates: route(getDeletedCertificates),
      CreateCertificate: route(createCertificate),
      MergeCertificate: route(mergeCertificate),
      ImportCertificate: route(importCertificate),
      UpdateCertificate: route(updateCertificate),
      UpdateCertificatePolicy: route(updateCertificatePolicy),
      UpdateCertificateOperation: route(updateCertificateOperation),
      DeleteCertificateOperation: route(deleteCertificateOperation),
      DeleteCertificate: route(deleteCertificate),
      BackupCertificate: route(backupCertificate),
      RestoreCertificate: route(restoreCertificate),
      RecoverDeletedCertificate: route(recoverDeletedCertificate),
      PurgeDeletedCertificate: route(purgeDeletedCertificate),
      GetCertificateIssuer: route(getCertificateIssuer),
      GetCertificateIssuers: route(getCertificateIssuers),
      SetCertificateIssuer: route(setCertificateIssuer),
      UpdateCertificateIssuer: route(updateCertificateIssuer),
      DeleteCertificateIssuer: route(deleteCertificateIssuer),
      GetCertificateContacts: route(getCertificateContacts),
      SetCertificateContacts: route(setCertificateContacts),
      DeleteCertificateContacts: route(deleteCertificateContacts),

      "CertificateRead.all": route((request: { name: string }) =>
        Effect.gen(function* () {
          const cert = yield* read.get(request.name);
          const missing = yield* read.get(`${request.name}-missing`);
          const policy = yield* read.policy(request.name);
          const operation = yield* read.operation(request.name);
          const versions = yield* read.versions(request.name);
          const page = yield* read.list({ maxresults: 25 });
          return {
            x5t: cert?.x5t,
            missing: missing === undefined,
            subject: policy?.x509_props?.subject,
            status: operation?.status,
            versions: versions.value.map((item) => item.id),
            listed: page.value.map((item) => item.id),
            nextLink: page.nextLink,
          };
        }),
      ),
      "CertificateWrite.create": route((request: { name: string }) =>
        Effect.map(
          write.create(request.name, { policy: selfSigned(request.name) }),
          (op) => op.status,
        ),
      ),
      "CertificateWrite.import": route((request: { name: string; pem: string }) =>
        Effect.map(
          write.import(request.name, {
            value: request.pem,
            policy: { secret_props: { contentType: "application/x-pem-file" } },
          }),
          (cert) => cert.x5t,
        ),
      ),
      "CertificateWrite.update": route((request: { name: string }) =>
        Effect.gen(function* () {
          const cert = yield* write.update(request.name, {
            tags: { writtenBy: "CertificateWrite" },
          });
          const policy = yield* write.updatePolicy(request.name, {
            lifetime_actions: [
              { trigger: { days_before_expiry: 20 }, action: { action_type: "AutoRenew" } },
            ],
          });
          return { tags: cert.tags, lifetimeActions: policy.lifetime_actions };
        }),
      ),
      "CertificateWrite.delete": route((request: { name: string }) =>
        Effect.gen(function* () {
          const deleted = yield* write.delete(request.name);
          const again = yield* write.delete(`${request.name}-missing`);
          return { recoveryId: deleted?.recoveryId, missing: again === undefined };
        }),
      ),
      "CertificateReadWrite.roundtrip": route((request: { name: string }) =>
        Effect.gen(function* () {
          yield* readWrite.create(request.name, { policy: selfSigned(request.name) });
          const operation = yield* readWrite.operation(request.name).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (op) => op?.status !== "inProgress",
              times: 15,
            }),
          );
          const cert = yield* readWrite.get(request.name);
          return { status: operation?.status, x5t: cert?.x5t };
        }),
      ),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const name = url.pathname.startsWith("/call/")
          ? decodeURIComponent(url.pathname.slice("/call/".length))
          : "";
        const call = routes[name];
        if (call === undefined) return HttpServerResponse.text("not found", { status: 404 });
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({})));
        return yield* respond(call(body));
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.KeyVault.CertificateReadHttp,
        Azure.KeyVault.CertificateWriteHttp,
        Azure.KeyVault.CertificateReadWriteHttp,
        Azure.KeyVault.GetCertificateHttp,
        Azure.KeyVault.GetCertificatesHttp,
        Azure.KeyVault.GetCertificateVersionsHttp,
        Azure.KeyVault.GetCertificatePolicyHttp,
        Azure.KeyVault.GetCertificateOperationHttp,
        Azure.KeyVault.GetDeletedCertificateHttp,
        Azure.KeyVault.GetDeletedCertificatesHttp,
        Azure.KeyVault.CreateCertificateHttp,
        Azure.KeyVault.MergeCertificateHttp,
        Azure.KeyVault.ImportCertificateHttp,
        Azure.KeyVault.UpdateCertificateHttp,
        Azure.KeyVault.UpdateCertificatePolicyHttp,
        Azure.KeyVault.UpdateCertificateOperationHttp,
        Azure.KeyVault.DeleteCertificateOperationHttp,
        Azure.KeyVault.DeleteCertificateHttp,
        Azure.KeyVault.BackupCertificateHttp,
        Azure.KeyVault.RestoreCertificateHttp,
        Azure.KeyVault.RecoverDeletedCertificateHttp,
        Azure.KeyVault.PurgeDeletedCertificateHttp,
        Azure.KeyVault.GetCertificateIssuerHttp,
        Azure.KeyVault.GetCertificateIssuersHttp,
        Azure.KeyVault.SetCertificateIssuerHttp,
        Azure.KeyVault.UpdateCertificateIssuerHttp,
        Azure.KeyVault.DeleteCertificateIssuerHttp,
        Azure.KeyVault.GetCertificateContactsHttp,
        Azure.KeyVault.SetCertificateContactsHttp,
        Azure.KeyVault.DeleteCertificateContactsHttp,
      ),
    ),
  ),
) {}
