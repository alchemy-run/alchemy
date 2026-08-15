import * as certs from "@distilled.cloud/vercel/certs";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

export interface CertUpload {
  /** The certificate authority chain (PEM). */
  ca: string;
  /** The certificate private key (PEM). */
  key: string;
  /** The certificate (PEM). */
  cert: string;
  /**
   * Skip server-side validation of the certificate.
   * @default false
   */
  skipValidation?: boolean;
}

export interface CertProps {
  /**
   * The common names to issue the certificate for. The domains must resolve
   * to Vercel at issuance time — issuing for a domain that does not yet
   * resolve fails with the typed `DomainPretestFailed` error (HTTP 449).
   * Changing the common names replaces the certificate (certs are
   * immutable).
   *
   * Exactly one of `cns` or `upload` must be provided.
   */
  cns?: string[];
  /**
   * Upload a custom certificate instead of issuing one. Requires an
   * Enterprise plan (typed `PaymentRequired` otherwise). Changing the
   * upload replaces the certificate.
   */
  upload?: CertUpload;
}

export type Cert = Resource<
  "Vercel.Cert",
  CertProps,
  {
    /** The unique id of the certificate. */
    certId: string;
    /** The common names the certificate covers. */
    cns: string[];
    /** Timestamp (ms) when the certificate was created. */
    createdAt: number;
    /** Timestamp (ms) when the certificate expires. */
    expiresAt: number;
    /** Whether Vercel auto-renews the certificate. */
    autoRenew: boolean;
  },
  never,
  Providers
>;

type CertAttributes = Cert["Attributes"];

/**
 * A TLS certificate on the Vercel team — either issued by Vercel for
 * domains that resolve to it, or a custom certificate upload (Enterprise).
 *
 * Vercel issues and renews certificates automatically for project domains,
 * so an explicit `Cert` is only needed for advance issuance or custom
 * certificates. Certificates are immutable: any change to the requested
 * common names or the uploaded material replaces the certificate.
 *
 * @resource
 * @section Issuing a certificate
 * @example Issue for domains resolving to Vercel
 * ```typescript
 * const cert = yield* Vercel.Cert("Cert", {
 *   cns: ["acme.com", "www.acme.com"],
 * });
 * ```
 *
 * @section Custom certificates (Enterprise)
 * @example Upload a custom certificate
 * ```typescript
 * const cert = yield* Vercel.Cert("CustomCert", {
 *   upload: { ca: CA_PEM, key: KEY_PEM, cert: CERT_PEM },
 * });
 * ```
 *
 * @see https://vercel.com/docs/domains/custom-SSL-certificate
 */
export const Cert = Resource<Cert>("Vercel.Cert");

const sortedCns = (cns: ReadonlyArray<string> | undefined): string[] =>
  [...(cns ?? [])].sort();

const cnsEqual = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean => {
  const sa = sortedCns(a);
  const sb = sortedCns(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
};

const observeCert = (certId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    return yield* certs.getCertById({ id: certId, teamId }).pipe(
      Effect.map(
        (cert): CertAttributes => ({
          certId: cert.id,
          cns: [...cert.cns],
          createdAt: cert.createdAt,
          expiresAt: cert.expiresAt,
          autoRenew: cert.autoRenew,
        }),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

export const CertProvider = () =>
  Provider.succeed(Cert, {
    stables: ["certId", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Certificates are immutable — any material change replaces.
      if (!cnsEqual(news.cns, olds.cns)) {
        return { action: "replace" } as const;
      }
      if (
        JSON.stringify(news.upload ?? null) !==
        JSON.stringify(olds.upload ?? null)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output?.certId) return undefined;
      return yield* observeCert(output.certId);
    }),
    list: Effect.fn(function* () {
      const { teamId } = yield* VercelEnvironment.current;
      const rows: CertAttributes[] = [];
      // getCerts carries no pagination inputs in the spec — a single page is
      // the full enumeration surface.
      const page = yield* certs.getCerts({ teamId });
      for (const cert of page.certs) {
        rows.push({
          certId: cert.id,
          cns: [...cert.cns],
          createdAt: cert.createdAt,
          expiresAt: cert.expiresAt,
          autoRenew: cert.autoRenew,
        });
      }
      return rows;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Observe — the cert may already exist from a prior (unrecorded) run.
      const observed = output?.certId
        ? yield* observeCert(output.certId)
        : undefined;
      if (observed !== undefined) {
        // Certificates are immutable; material changes arrive as
        // replacements, so an existing cert is already converged.
        return observed;
      }
      if (news.upload !== undefined) {
        const uploaded = yield* certs.uploadCert({
          teamId,
          ca: news.upload.ca,
          key: news.upload.key,
          cert: news.upload.cert,
          ...(news.upload.skipValidation !== undefined
            ? { skipValidation: news.upload.skipValidation }
            : {}),
        });
        return {
          certId: uploaded.id,
          cns: [...uploaded.cns],
          createdAt: uploaded.createdAt,
          expiresAt: uploaded.expiresAt,
          autoRenew: uploaded.autoRenew,
        } satisfies CertAttributes;
      }
      if (news.cns === undefined || news.cns.length === 0) {
        return yield* Effect.die(
          "Vercel.Cert requires either `cns` (issue) or `upload` (custom certificate)",
        );
      }
      const issued = yield* certs.issueCert({ teamId, cns: [...news.cns] });
      return {
        certId: issued.id,
        cns: [...issued.cns],
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
        autoRenew: issued.autoRenew,
      } satisfies CertAttributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* certs
        .removeCert({ id: output.certId, teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
