import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface CertificateValidationProps {
  /**
   * ARN of the ACM certificate to wait on. Changing it replaces the
   * validation.
   */
  certificateArn: string;
  /**
   * Fully-qualified names of the DNS validation records published for the
   * certificate. Purely a dependency edge: pass the names (or the record
   * resources' name attributes) so the validation is ordered AFTER the
   * records land, and a consumer gated on this resource — an HTTPS listener,
   * a CloudFront distribution — never attaches a certificate that is still
   * `PENDING_VALIDATION`.
   */
  validationRecordFqdns?: string[];
}

export interface CertificateValidation extends Resource<
  "AWS.ACM.CertificateValidation",
  CertificateValidationProps,
  {
    /**
     * ARN of the validated certificate — the value to hand to consumers, so
     * they depend on issuance rather than on the bare request.
     */
    certificateArn: string;
    /**
     * Certificate status observed at the end of the last reconcile (always
     * `ISSUED` after a successful reconcile).
     */
    status: acm.CertificateStatus | undefined;
    /**
     * The validation record names this resource was ordered after.
     */
    validationRecordFqdns: string[] | undefined;
    /**
     * Certificate issue timestamp.
     */
    issuedAt: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * The certificate did not reach `ISSUED` inside the issuance budget, or ACM
 * moved it to a terminal failure state (`FAILED`, `VALIDATION_TIMED_OUT`,
 * `REVOKED`, …).
 */
export class CertificateNotIssued extends Data.TaggedError(
  "CertificateNotIssued",
)<{
  readonly certificateArn: string;
  readonly status: acm.CertificateStatus | undefined;
  readonly failureReason: acm.FailureReason | undefined;
  readonly message: string;
}> {}

/**
 * Waits for an ACM certificate to be issued after its DNS validation records
 * have been published elsewhere — the same split Terraform's
 * `aws_acm_certificate_validation` draws: `AWS.ACM.Certificate` requests the
 * certificate and exposes its validation records, the DNS provider of your
 * choice publishes them, and this resource is the node consumers depend on so
 * they only ever see an `ISSUED` certificate.
 *
 * Reconcile polls `DescribeCertificate` every 10 seconds for up to 5 minutes
 * (the issuance budget — ACM typically issues within a minute of the record
 * becoming resolvable) and fails with {@link CertificateNotIssued} when the
 * budget runs out or the certificate reaches a terminal failure state. Delete
 * is a no-op: the validation owns nothing in the cloud.
 *
 * ### Validating a Certificate
 * **Example:** DNS records on Cloudflare, certificate on ACM
 * ```typescript
 * const certificate = yield* AWS.ACM.Certificate("Certificate", {
 *   domainName: "api.example.com",
 *   region: "us-west-2",
 * });
 * const record = yield* Cloudflare.DNS.Record("Validation", {
 *   name: certificate.domainValidationOptions.pipe(
 *     Output.map((options) => options[0].ResourceRecord!.Name),
 *   ),
 *   type: "CNAME",
 *   content: certificate.domainValidationOptions.pipe(
 *     Output.map((options) => options[0].ResourceRecord!.Value),
 *   ),
 *   proxied: false,
 * });
 * const validation = yield* AWS.ACM.CertificateValidation("Validation", {
 *   certificateArn: certificate.certificateArn,
 *   validationRecordFqdns: [record.name],
 * });
 * yield* AWS.ELBv2.Listener("Https", {
 *   loadBalancerArn: loadBalancer.loadBalancerArn,
 *   targetGroupArn: targetGroup.targetGroupArn,
 *   port: 443,
 *   protocol: "HTTPS",
 *   // Depends on issuance, not on the request.
 *   certificateArn: validation.certificateArn,
 * });
 * ```
 *
 * @resource
 */
export const CertificateValidation = Resource<CertificateValidation>(
  "AWS.ACM.CertificateValidation",
);

/** Poll cadence and budget for issuance (10s × 30 = 5 minutes). */
const ISSUANCE_POLL_INTERVAL = "10 seconds";
const ISSUANCE_POLL_ATTEMPTS = 30;

const ACM_REGION = "us-east-1" as const;

/**
 * Region an existing certificate lives in, parsed from its ARN
 * (`arn:aws:acm:{region}:{account}:certificate/...`).
 */
const regionOfCertificateArn = (certificateArn: string) =>
  certificateArn.split(":")[3] || ACM_REGION;

const describeCertificate = (certificateArn: string) =>
  acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
    Effect.map((response) => response.Certificate),
    Effect.provideService(
      AwsRegion,
      Effect.succeed(
        regionOfCertificateArn(certificateArn) as typeof ACM_REGION,
      ),
    ),
  );

const isTerminalFailure = (status: acm.CertificateStatus | undefined) =>
  status === "FAILED" ||
  status === "VALIDATION_TIMED_OUT" ||
  status === "REVOKED" ||
  status === "EXPIRED" ||
  status === "INACTIVE";

const toAttrs = (
  props: CertificateValidationProps,
  detail: acm.CertificateDetail | undefined,
): CertificateValidation["Attributes"] => ({
  certificateArn: props.certificateArn,
  status: detail?.Status,
  validationRecordFqdns: props.validationRecordFqdns,
  issuedAt: detail?.IssuedAt,
});

export const CertificateValidationProvider = () =>
  Provider.succeed(CertificateValidation, {
    stables: ["certificateArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.certificateArn !== undefined &&
        olds.certificateArn !== news.certificateArn
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const certificateArn = output?.certificateArn ?? olds?.certificateArn;
      if (certificateArn === undefined) {
        return undefined;
      }
      const detail = yield* describeCertificate(certificateArn).pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
      if (detail === undefined) {
        return undefined;
      }
      return toAttrs(
        {
          certificateArn,
          validationRecordFqdns:
            output?.validationRecordFqdns ?? olds?.validationRecordFqdns,
        },
        detail,
      );
    }),
    list: () => Effect.succeed([]),
    reconcile: Effect.fn(function* ({ news, session }) {
      // Observe → wait: the certificate is the only cloud state here, and
      // issuance is driven by DNS records published by sibling resources.
      // Poll until ISSUED, bounded by the issuance budget.
      const detail = yield* describeCertificate(news.certificateArn).pipe(
        Effect.flatMap((detail) => {
          if (detail?.Status === "ISSUED") {
            return Effect.succeed(detail);
          }
          if (isTerminalFailure(detail?.Status)) {
            return Effect.fail(
              new CertificateNotIssued({
                certificateArn: news.certificateArn,
                status: detail?.Status,
                failureReason: detail?.FailureReason,
                message:
                  `ACM certificate ${news.certificateArn} reached terminal ` +
                  `status ${detail?.Status}` +
                  (detail?.FailureReason ? ` (${detail.FailureReason})` : ""),
              }),
            );
          }
          return Effect.fail(
            new CertificateNotIssued({
              certificateArn: news.certificateArn,
              status: detail?.Status,
              failureReason: detail?.FailureReason,
              message:
                `ACM certificate ${news.certificateArn} is still ` +
                `${detail?.Status ?? "unknown"} after the 5 minute issuance ` +
                "budget — check that the DNS validation records resolve.",
            }),
          );
        }),
        Effect.retry({
          while: (error): boolean =>
            error._tag === "CertificateNotIssued" &&
            !isTerminalFailure(error.status),
          schedule: Schedule.max([
            Schedule.spaced(ISSUANCE_POLL_INTERVAL),
            Schedule.recurs(ISSUANCE_POLL_ATTEMPTS),
          ]),
        }),
      );
      yield* session.note(`${news.certificateArn} ISSUED`);
      return toAttrs(news, detail);
    }),
    // Nothing to tear down — the certificate belongs to `AWS.ACM.Certificate`.
    delete: () => Effect.void,
  });
