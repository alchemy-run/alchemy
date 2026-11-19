import * as DO from "@distilled.cloud/digitalocean";
import type {
  Certificate as ApiCertificate,
  CertificateState,
} from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { setEquals } from "./internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type { CertificateState } from "@distilled.cloud/digitalocean";

export type CertificateProps =
  | {
      /**
       * Certificate name, unique within the team. A change replaces the
       * certificate.
       *
       * @default a generated physical name
       */
      name?: string;
      /** DigitalOcean obtains and renews the certificate from Let's Encrypt. */
      type: "lets_encrypt";
      /**
       * Host names the certificate covers. Each one must be in a domain
       * hosted on DigitalOcean DNS (`DigitalOcean.Domain`), because the
       * challenge is answered with DNS records. A change replaces the
       * certificate.
       */
      dnsNames: string[];
    }
  | {
      /**
       * Certificate name, unique within the team. A change replaces the
       * certificate.
       *
       * @default a generated physical name
       */
      name?: string;
      /** A certificate you bring. */
      type: "custom";
      /** PEM private key. A change replaces the certificate. */
      privateKey: string | Redacted.Redacted<string>;
      /** PEM leaf certificate. A change replaces the certificate. */
      leafCertificate: string;
      /** PEM intermediate chain. A change replaces the certificate. */
      certificateChain?: string;
    };

export type Certificate = Resource<
  "DigitalOcean.Certificate",
  CertificateProps,
  {
    /** Certificate id (UUID). */
    certificateId: string;
    /** Certificate name. */
    name: string;
    /** `lets_encrypt` or `custom`. */
    type: string;
    /** `verified` once usable, `pending` while Let's Encrypt issues it. */
    state: CertificateState;
    /** Host names the certificate covers. */
    dnsNames: string[];
    /** ISO 8601 expiry time. */
    notAfter: string | undefined;
    /** SHA-1 fingerprint. */
    sha1Fingerprint: string | undefined;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type CertificateAttributes = Certificate["Attributes"];

/**
 * A TLS certificate for DigitalOcean load balancers and CDN endpoints,
 * either issued and renewed by Let's Encrypt or one you upload. A
 * certificate cannot change, so every change replaces it, creating the new
 * one before deleting the old one.
 *
 * Alchemy owns a certificate whose name it generated or whose id it
 * recorded. A certificate that already has the chosen name is `Unowned` and
 * needs `--adopt`.
 *
 * ### Let's Encrypt
 * **Example:** A certificate for a domain on DigitalOcean DNS
 * ```typescript
 * const domain = yield* DigitalOcean.Domain("shop", { name: "shop.example.com" });
 * const cert = yield* DigitalOcean.Certificate("shop-cert", {
 *   type: "lets_encrypt",
 *   dnsNames: [domain.name],
 * });
 * ```
 *
 * ### Uploading a Certificate
 * **Example:** A certificate issued elsewhere
 * ```typescript
 * const cert = yield* DigitalOcean.Certificate("shop-cert", {
 *   type: "custom",
 *   privateKey: yield* Config.Redacted("TLS_PRIVATE_KEY"),
 *   leafCertificate: yield* Config.string("TLS_CERTIFICATE"),
 *   certificateChain: yield* Config.string("TLS_CHAIN"),
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Certificates
 *
 * @resource
 * @product Certificates
 * @category Networking
 */
export const Certificate = Resource<Certificate>("DigitalOcean.Certificate");

export class CertificateWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.CertificateWaitTimedOut",
)<{
  readonly certificateId: string;
  readonly waitingFor: string;
  readonly lastState: CertificateState | undefined;
}> {
  override get message() {
    return `Certificate ${this.certificateId} timed out waiting for ${this.waitingFor} (last state: ${this.lastState ?? "missing"}).`;
  }
}

export class CertificateIssueFailed extends Data.TaggedError(
  "DigitalOcean.CertificateIssueFailed",
)<{
  readonly certificateId: string;
}> {
  override get message() {
    return `Certificate ${this.certificateId} is in the 'error' state. For Let's Encrypt, check that every DNS name is in a domain hosted on DigitalOcean.`;
  }
}

const NAME_MAX_LENGTH = 255;

const PAGE_SIZE = 200;

// Let's Encrypt issues within one to three minutes (≈ 5 min budget).
const ISSUE_POLL: PollBudget = { maxDelay: "10 seconds", times: 36 };

const DELETE_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

const toAttrs = (cert: ApiCertificate): CertificateAttributes => ({
  certificateId: cert.id,
  name: cert.name,
  type: cert.type,
  state: cert.state,
  dnsNames: [...(cert.dns_names ?? [])],
  notAfter: cert.not_after || undefined,
  sha1Fingerprint: cert.sha1_fingerprint || undefined,
  createdAt: cert.created_at,
});

const physicalName = (id: string) => createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });

const observeById = (certificateId: string) =>
  noneIfNotFound(
    DO.getCertificate({ certificate_id: certificateId }).pipe(Effect.map((r) => r.certificate)),
  );

const observeByName = (name: string) =>
  DO.listCertificates.items({ per_page: PAGE_SIZE, name }).pipe(
    Stream.filter((cert) => cert.name === name),
    Stream.runHead,
  );

const observeOwned = Effect.fn(function* (
  certificateId: string | undefined,
  generatedName: string | undefined,
) {
  if (certificateId !== undefined) {
    const byId = yield* observeById(certificateId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<ApiCertificate>();
  return yield* observeByName(generatedName);
});

const waitUntilVerified = (certificateId: string) =>
  pollUntil(observeById(certificateId), {
    ...ISSUE_POLL,
    until: (observed): observed is Option.Some<ApiCertificate> =>
      Option.isSome(observed) &&
      (observed.value.state === "verified" || observed.value.state === "error"),
    onTimeout: (last) =>
      new CertificateWaitTimedOut({
        certificateId,
        waitingFor: "the verified state",
        lastState: Option.getOrUndefined(last)?.state,
      }),
  }).pipe(
    Effect.map((observed) => observed.value),
    Effect.filterOrFail(
      (cert) => cert.state === "verified",
      () => new CertificateIssueFailed({ certificateId }),
    ),
  );

const waitUntilGone = (certificateId: string) =>
  pollUntil(observeById(certificateId), {
    ...DELETE_POLL,
    until: Option.isNone,
    onTimeout: (last) =>
      new CertificateWaitTimedOut({
        certificateId,
        waitingFor: "deletion",
        lastState: Option.getOrUndefined(last)?.state,
      }),
  });

const createCertificate = (name: string, news: CertificateProps) =>
  DO.createCertificate({
    body:
      news.type === "lets_encrypt"
        ? { name, type: "lets_encrypt", dns_names: news.dnsNames }
        : {
            name,
            type: "custom",
            private_key: news.privateKey,
            leaf_certificate: news.leafCertificate,
            certificate_chain: news.certificateChain,
          },
  }).pipe(Effect.map((response) => response.certificate));

const sameMaterial = (news: CertificateProps, olds: CertificateProps) => {
  if (news.type === "lets_encrypt" && olds.type === "lets_encrypt") {
    return setEquals(news.dnsNames, olds.dnsNames);
  }
  if (news.type === "custom" && olds.type === "custom") {
    return (
      news.leafCertificate === olds.leafCertificate &&
      news.certificateChain === olds.certificateChain
    );
  }
  return false;
};

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["certificateId", "name", "type", "createdAt"],
    // A certificate carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const owned = yield* observeOwned(output?.certificateId, generatedName);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      return named.pipe(
        Option.map((cert) =>
          cert.id === previous?.certificateId ? toAttrs(cert) : Unowned(toAttrs(cert)),
        ),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name || !sameMaterial(news, olds)) {
        // Names are unique, so a chosen name frees up before the new
        // certificate takes it.
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;
      const observed = yield* observeOwned(output?.certificateId, generatedName);
      const cert = yield* Option.match(observed, {
        onNone: () => createCertificate(name, news),
        onSome: Effect.succeed,
      });
      const verified = yield* waitUntilVerified(cert.id);
      return toAttrs(verified);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteCertificate({ certificate_id: output.certificateId }));
      yield* waitUntilGone(output.certificateId);
    }),
  });
