import { resolve4, Resolver } from "node:dns/promises";
/**
 * DNS helpers for the AWS website suites that publish real hostnames under
 * the standing Cloudflare test zone: delegate a stack-owned sub-zone to
 * another DNS host, and wait for its authoritative nameservers to answer
 * before the first HTTPS request.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** The standing Cloudflare test zone. */
export const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

export class NotYet extends Data.TaggedError("NotYet")<{ readonly what: string }> {}

/** Lowercase, no trailing dot. */
export const bare = (name: string) => name.replace(/\.$/, "").toLowerCase();

/** The id of the standing Cloudflare test zone. */
export const cloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found in account`));
  }
  return zone.id;
});

/** NS records in the Cloudflare zone delegating `name` to `nameServers`. */
export const delegate = (zoneId: string, name: string, nameServers: readonly string[]) =>
  Effect.forEach(nameServers, (nameServer, index) =>
    Cloudflare.DNS.Record(`Delegation${index + 1}`, {
      zoneId,
      name,
      type: "NS",
      content: bare(nameServer),
    }),
  );

/**
 * Wait until every authoritative nameserver answers `name` acceptably, so
 * the first HTTPS request never resolves (and negatively caches) the
 * hostname before it exists. A fresh resolver per attempt: a resolver
 * caches the negative answers it got.
 */
export const waitForAuthoritative = (
  nameServers: readonly string[],
  name: string,
  query: (resolver: Resolver, name: string) => Promise<string[]>,
  accept: (answers: string[]) => boolean,
) =>
  Effect.gen(function* () {
    const servers = (yield* Effect.forEach(nameServers, (nameServer) =>
      Effect.tryPromise(() => resolve4(bare(nameServer))).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(
      servers,
      (server) =>
        Effect.gen(function* () {
          const resolver = yield* Effect.sync(() => {
            const r = new Resolver();
            r.setServers([server]);
            return r;
          });
          const answers = yield* Effect.tryPromise(() => query(resolver, name)).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          );
          if (!accept(answers)) {
            return yield* new NotYet({ what: `${name} @ ${server}` });
          }
        }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
      { discard: true },
    );
  });

export const cnameTo =
  (target: string) =>
  (answers: string[]): boolean =>
    answers.some((answer) => bare(answer) === bare(target));

export const queryCname = (resolver: Resolver, name: string) => resolver.resolveCname(name);

export const queryA = (resolver: Resolver, name: string) => resolver.resolve4(name);
