import * as certificates from "@distilled.cloud/stackit/certificates";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { secretsDiffer } from "../internal/equal.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  CERTIFICATES_SERVICE_ID,
  getCertificateOrUndefined,
  listAllCertificates,
  physicalName,
} from "./internal.ts";

export interface CertificateProps extends ProjectScopedProps {
  /**
   * Name of the certificate: 1-63 characters of `[0-9a-z-]`, neither starting nor ending
   * with `-`. Changing it replaces the certificate.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /** The PEM encoded certificate. Changing it replaces the certificate. */
  publicKey: string;
  /**
   * The PEM encoded private key. STACKIT never returns it. Changing it replaces the
   * certificate.
   */
  privateKey: string | Redacted.Redacted<string>;
  /**
   * User labels, at most 64 including Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`, `alchemy.instance`), which are added automatically. Keys
   * starting with `stackit-` are reserved by STACKIT. There is no update operation, so
   * changing them replaces the certificate.
   */
  labels?: Record<string, string>;
}

export interface CertificateAttributes {
  /** STACKIT certificate id. It changes with every replacement. */
  certificateId: string;
  /** Name of the certificate. */
  certificateName: string;
  /** Project of the certificate. */
  projectId: string;
  /** Region of the certificate. */
  region: string;
  /** The PEM encoded certificate, as STACKIT reports it. */
  publicKey: string;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
  /** Details STACKIT parsed from the certificate: names, validity, issuer, fingerprints. */
  data: certificates.Data | undefined;
  /** Load balancers and listeners using the certificate. */
  usage: certificates.Usage | undefined;
}

export type Certificate = Resource<
  "Stackit.Certificates.Certificate",
  CertificateProps,
  CertificateAttributes,
  never,
  Providers
>;

/**
 * A TLS certificate and private key stored for STACKIT Application Load Balancers, whose
 * listeners reference it by id. STACKIT doesn't issue certificates: bring a PEM pair from
 * your CA or ACME client. CDN custom domains don't use this store; they take their
 * certificate inline, see `Stackit.CDN.CustomDomain`.
 *
 * The API has no update operation, so changing any prop replaces the certificate: the new
 * one is created first so listeners can move to its id, then the old one is deleted. The
 * first deploy also enables the service (`cloud.stackit.loadbalancer`) for the project. The
 * private key is sent once and kept in Alchemy state as `Redacted` when you pass it so.
 *
 * Ownership is tracked with labels. A certificate with the same name that lacks them is
 * reported as unowned and only taken over with `--adopt`.
 *
 * See [STACKIT's Certificates docs](https://docs.stackit.cloud/products/network/load-balancing-and-content-delivery/application-load-balancer/basics/basic-concepts-certificate-api/).
 *
 * :::caution[Changing any prop replaces the Certificate]
 * The API has no update operation. The new certificate is created first so listeners
 * can move to its id, then the old one is deleted.
 * :::
 *
 * ### Storing a Certificate
 * **Example:** A PEM pair from configuration
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const publicKey = Config.String("TLS_CERTIFICATE_PEM");
 * const privateKey = Config.Redacted("TLS_PRIVATE_KEY_PEM");
 * const certificate = yield* Stackit.Certificates.Certificate("Tls", {
 *   publicKey,
 *   privateKey,
 * });
 * // certificate.certificateId is what an ALB listener references.
 * ```
 *
 * **Example:** With a name and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const publicKey = Config.String("TLS_CERTIFICATE_PEM");
 * const privateKey = Config.Redacted("TLS_PRIVATE_KEY_PEM");
 * const certificate = yield* Stackit.Certificates.Certificate("Tls", {
 *   name: "www-example-com",
 *   publicKey,
 *   privateKey,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Reading Expiry
 * **Example:** The validity STACKIT parsed
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const publicKey = Config.String("TLS_CERTIFICATE_PEM");
 * const privateKey = Config.Redacted("TLS_PRIVATE_KEY_PEM");
 * const certificate = yield* Stackit.Certificates.Certificate("Tls", {
 *   publicKey,
 *   privateKey,
 * });
 * // certificate.data holds dnsNames, notBefore, notAfter and fingerprintSha256.
 * ```
 *
 * ### Runtime Operations
 * **Example:** Check expiry from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Tls = Stackit.Certificates.Certificate("Tls", {
 *   publicKey: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
 *   privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"),
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getCertificate = yield* Stackit.Certificates.GetCertificate(yield* Tls);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getCertificate();
 *         return yield* HttpServerResponse.json({ notAfter: live.data?.notAfter });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Certificates.GetCertificateHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renewing a certificate
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * // A new PEM pair creates a new certificate with a new id, then deletes the old one.
 * // STACKIT refuses to delete a certificate a load balancer still uses, so a listener
 * // that references the old id must move to `certificateId` in the same deploy.
 * const publicKey = Config.String("TLS_RENEWED_CERTIFICATE_PEM");
 * const privateKey = Config.Redacted("TLS_RENEWED_PRIVATE_KEY_PEM");
 * const certificate = yield* Stackit.Certificates.Certificate("Tls", {
 *   publicKey,
 *   privateKey,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Application Load Balancer
 * @category Certificates
 */
export const Certificate = Resource<Certificate>("Stackit.Certificates.Certificate");

/**
 * How long a delete keeps trying while a load balancer lets go of the certificate.
 * The spec documents the delete's 400 as `certificate is used by a load balancer`.
 */
const IN_USE_RETRY = { schedule: Schedule.spaced("10 seconds"), times: 9 } as const;

/** PEM without its layout, since the API may not return the line breaks it was given. */
const normalizePem = (pem: string): string => pem.replace(/\s+/g, "");

const toAttrs = (
  scope: { projectId: string; region: string },
  certificate: certificates.GetCertificateResponse,
): CertificateAttributes => ({
  certificateId: certificate.id ?? "",
  certificateName: certificate.name ?? "",
  ...scope,
  publicKey: certificate.publicKey ?? "",
  labels: stripInternalLabels(certificate.labels),
  data: certificate.data,
  usage: certificate.usage,
});

/**
 * A certificate of this logical id, under `name` when one is given. A replacement shares
 * both with the one it replaces, and garbage collection deletes that one afterwards, so
 * with `instanceId` only this generation matches.
 */
const findOwned = (
  scope: { projectId: string; region: string },
  id: string,
  name: string | undefined,
  instanceId: string | undefined,
) =>
  Effect.gen(function* () {
    const all = yield* listAllCertificates(scope);
    for (const certificate of all) {
      if (name !== undefined && certificate.name !== name) continue;
      if (instanceId !== undefined && !hasInstanceLabel(instanceId, certificate.labels)) continue;
      if (yield* hasAlchemyLabels(id, certificate.labels)) return certificate;
    }
    return undefined;
  });

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["certificateId", "certificateName", "projectId", "region", "publicKey"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const all = yield* listAllCertificates(scope);
      return all
        .filter((certificate) => isAlchemyOwned(certificate.labels))
        .map((certificate) => toAttrs(scope, certificate));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Always create the new one first. A load balancer can be using the old one, and
      // STACKIT refuses to delete it until the listener has moved to the new id. STACKIT
      // assigns the id, so even an unchanged name doesn't make the two collide.
      if (
        hasUnresolvedTrigger<CertificateProps>(news, [
          "name",
          "publicKey",
          "privateKey",
          "labels",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      const resolved = triggerProps<CertificateProps>(news);
      // Props against props where there are any: an observed PEM or label set can differ
      // from what was sent without anything having changed.
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      if (
        scopeChanged ||
        (resolved.name ?? output.certificateName) !== output.certificateName ||
        normalizePem(resolved.publicKey) !== normalizePem(olds?.publicKey ?? output.publicKey) ||
        (olds !== undefined && secretsDiffer(resolved.privateKey, olds.privateKey)) ||
        !recordsEqual(toLabels(resolved.labels), toLabels(olds ? olds.labels : output.labels))
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      // A generated name holds the generation, and a cold start's is new: labels find it.
      const name = output?.certificateName ?? olds?.name;
      let observed =
        output !== undefined
          ? yield* getCertificateOrUndefined(scope, output.certificateId)
          : undefined;
      if (observed === undefined) {
        // A crashed create or lost state: find it by its name and labels.
        observed = yield* findOwned(
          scope,
          id,
          name,
          readGeneration({ instanceId, output, previous }),
        );
      }
      // A certificate the labels don't claim, under an explicit name, is someone else's. A
      // replacement doesn't look: what `read` returns here becomes its `output`, so this must
      // never hand back the generation being replaced, and it creates its own id anyway.
      if (observed === undefined && olds?.name !== undefined && previous === undefined) {
        const all = yield* listAllCertificates(scope);
        observed = all.find((certificate) => certificate.name === olds.name);
      }
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.certificateName ?? (yield* physicalName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      yield* ensureServiceEnabled({ ...scope, serviceId: CERTIFICATES_SERVICE_ID });

      // 1. Observe. `output` is a cache: its id only counts at the desired scope.
      let current =
        output?.projectId === scope.projectId && output.region === scope.region
          ? yield* getCertificateOrUndefined(scope, output.certificateId)
          : undefined;
      if (current === undefined) current = yield* findOwned(scope, id, news.name, instanceId);

      // 2. Ensure. Nothing else can change: `diff` replaces on every other prop.
      if (current === undefined) {
        current = yield* certificates.createCertificate({
          ...scope,
          name,
          publicKey: news.publicKey,
          privateKey: news.privateKey,
          labels,
        });
      }

      // 3. Return.
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const current = yield* getCertificateOrUndefined(scope, output.certificateId);
      if (current === undefined) return;
      // A listener moved to a new certificate in this deploy may not have let go yet.
      yield* certificates
        .deleteCertificate({ ...scope, id: output.certificateId })
        .pipe(Effect.retry({ while: (error) => error._tag === "BadRequest", ...IN_USE_RETRY }));
    }),
  });
