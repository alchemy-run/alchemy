import * as route53 from "@distilled.cloud/aws/route-53";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class HostedZoneLookupInvalidProps extends Data.TaggedError("HostedZoneLookupInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A same-name public-zone collision cannot be resolved safely by inference. */
export class AmbiguousHostedZone extends Data.TaggedError("AmbiguousHostedZone")<{
  readonly domainName: string;
  readonly zoneName: string;
  readonly hostedZoneIds: readonly string[];
  readonly message: string;
}> {}

export const normalizeHostedZoneName = (name: string): string =>
  `${name.replace(/\.+$/, "").toLowerCase()}.`;

/** Longest-to-shortest parent candidates, excluding a TLD-only candidate. */
export const hostedZoneNameCandidates = (domainName: string): string[] => {
  const labels = domainName
    .replace(/\.+$/, "")
    .split(".")
    .filter((label) => label.length > 0);
  return Array.from({ length: Math.max(0, labels.length - 1) }, (_, index) =>
    normalizeHostedZoneName(labels.slice(index).join(".")),
  );
};

export type HostedZoneListByName<R = never> = (
  request: route53.ListHostedZonesByNameRequest,
) => Effect.Effect<route53.ListHostedZonesByNameResponse, route53.ListHostedZonesByNameError, R>;

export interface PublicHostedZone {
  readonly id: string;
  readonly name: string;
}

const normalizeHostedZoneId = (id: string): string => id.replace(/^\/hostedzone\//, "");

const findPublicHostedZoneWith = Effect.fn("findPublicHostedZoneWith")(function* <R>(
  domainName: string,
  list: HostedZoneListByName<R>,
) {
  for (const candidate of hostedZoneNameCandidates(domainName)) {
    const matches: PublicHostedZone[] = [];
    let request: route53.ListHostedZonesByNameRequest = {
      DNSName: candidate,
      MaxItems: 100,
    };
    const cursors = new Set<string>();

    while (true) {
      const response = yield* list(request);
      for (const zone of response.HostedZones ?? []) {
        if (
          zone.Id !== undefined &&
          zone.Name !== undefined &&
          normalizeHostedZoneName(zone.Name) === candidate &&
          zone.Config?.PrivateZone !== true
        ) {
          matches.push({
            id: normalizeHostedZoneId(zone.Id),
            name: normalizeHostedZoneName(zone.Name),
          });
        }
      }

      const nextName = response.NextDNSName;
      const nextId = response.NextHostedZoneId;
      if (
        !response.IsTruncated ||
        nextName === undefined ||
        normalizeHostedZoneName(nextName) !== candidate ||
        nextId === undefined
      ) {
        break;
      }
      const cursor = `${nextName}\0${nextId}`;
      if (cursors.has(cursor)) {
        return yield* new HostedZoneLookupInvalidProps({
          message: `Route 53 hosted-zone pagination repeated cursor ${cursor}`,
        });
      }
      cursors.add(cursor);
      request = { DNSName: nextName, HostedZoneId: nextId, MaxItems: 100 };
    }

    if (matches.length > 1) {
      return yield* new AmbiguousHostedZone({
        domainName,
        zoneName: candidate,
        hostedZoneIds: matches.map((match) => match.id),
        message:
          `Multiple public Route 53 hosted zones match "${candidate}" ` +
          `for "${domainName}" (${matches.map((match) => match.id).join(", ")}); ` +
          "pass hostedZoneId explicitly.",
      });
    }
    if (matches.length === 1) return matches[0];
  }
  return undefined;
});

/** Testable lookup boundary; production callers use {@link findPublicHostedZone}. */
export const findPublicHostedZoneFrom = findPublicHostedZoneWith;

export const findPublicHostedZoneIdFrom = Effect.fn("findPublicHostedZoneIdFrom")(function* <R>(
  domainName: string,
  list: HostedZoneListByName<R>,
) {
  const match = yield* findPublicHostedZoneFrom(domainName, list);
  return match?.id;
});

/**
 * Find the most specific PUBLIC Route 53 hosted zone containing
 * `domainName`, walking up its labels (`svc.api.example.com` →
 * `api.example.com` → `example.com`). Wildcard labels (`*`) never name a
 * zone, so they fall through to the parent naturally. Returns the bare
 * zone id (no `/hostedzone/` prefix), or `undefined` when no public zone
 * matches.
 *
 * Shared by every provider that infers a hosted zone from a hostname
 * (Route 53 Record/Records, ACM Certificate validation, ECS Service DNS).
 */
export const findPublicHostedZoneId = Effect.fn("findPublicHostedZoneId")(function* (
  domainName: string,
) {
  return yield* findPublicHostedZoneIdFrom(domainName, route53.listHostedZonesByName);
});

/**
 * Resolve the hosted zone for `domainName`: the explicit id when given,
 * otherwise the most specific public zone in the account (see
 * {@link findPublicHostedZoneId}). Fails with an actionable error when
 * neither yields a zone.
 */
export const resolveHostedZoneId = Effect.fn("resolveHostedZoneId")(function* (
  hostedZoneId: string | undefined,
  domainName: string,
) {
  if (hostedZoneId !== undefined) {
    return hostedZoneId;
  }
  const inferred = yield* findPublicHostedZoneId(domainName);
  if (inferred === undefined) {
    return yield* new HostedZoneLookupInvalidProps({
      message:
        `No public Route 53 hosted zone in this account contains "${domainName}" — ` +
        `create the zone first or pass "hostedZoneId" explicitly.`,
    });
  }
  return inferred;
});
