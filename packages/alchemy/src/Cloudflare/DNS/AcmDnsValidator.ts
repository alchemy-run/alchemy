import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  dnsValidatorLayer,
  DnsValidatorError,
  type DnsValidationRecord,
} from "../../AWS/ACM/DnsValidator.ts";
import type { Input } from "../../Input.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  resolveZoneId,
  type Reference as ZoneReference,
} from "../Zone/lookup.ts";
import { upsertRecordAt } from "./Records.ts";

/**
 * Validate an `AWS.ACM.Certificate` through a Cloudflare zone — for a domain
 * registered with (or delegated to) Cloudflare. The certificate provider
 * upserts ACM's validation CNAMEs (always DNS-only) and waits for issuance.
 * The implementation is registered by `Cloudflare.providers()`.
 *
 * **Example:**
 * ```typescript
 * const cert = yield* AWS.ACM.Certificate("Cert", {
 *   domainName: "www.example.com",
 *   dnsValidation: Cloudflare.DNS.AcmValidator(),
 * });
 * ```
 */
export const AcmValidator = (
  options: {
    /**
     * Zone id, zone name, or `Zone` resource. Inferred from each record name
     * when omitted.
     */
    readonly zone?: Input<ZoneReference>;
  } = {},
) => ({
  type: "Cloudflare.DNS" as const,
  zone: options.zone,
});

const VALIDATION_TTL = 60;

const isZoneReference = (zone: unknown): zone is ZoneReference =>
  (typeof zone === "string" && zone.length > 0) ||
  (typeof zone === "object" &&
    zone !== null &&
    typeof (zone as { zoneId?: unknown }).zoneId === "string");

const upsertValidationRecord = (
  zone: ZoneReference | undefined,
  record: DnsValidationRecord,
) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const name = record.name.replace(/\.$/, "");
    const zoneId = yield* resolveZoneId({ accountId, zone, hostname: name });
    yield* upsertRecordAt(zoneId, {
      type: "CNAME",
      name,
      content: record.value.replace(/\.$/, ""),
      ttl: VALIDATION_TTL,
      proxied: false,
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DnsValidatorError({
          message: `Could not publish ACM validation record ${record.name}`,
          cause,
        }),
    ),
  );

/**
 * Registers the `Cloudflare.DNS` ACM validator with the `AWS.ACM.Certificate`
 * provider, capturing the Cloudflare credentials and account from the
 * providers layer.
 */
export const AcmDnsValidatorLive = dnsValidatorLayer(
  "Cloudflare.DNS",
  (descriptor) =>
    Effect.succeed({
      upsert: (records: ReadonlyArray<DnsValidationRecord>) =>
        Effect.forEach(
          records,
          (record) =>
            upsertValidationRecord(
              isZoneReference(descriptor.zone) ? descriptor.zone : undefined,
              record,
            ),
          { discard: true },
        ),
    }),
).pipe(Layer.provide(FetchHttpClient.layer));
