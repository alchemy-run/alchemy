import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

interface NodeDns {
  readonly resolveNs: (name: string) => Promise<string[]>;
  readonly resolve4: (name: string) => Promise<string[]>;
  readonly Resolver: new () => {
    setServers(servers: string[]): void;
    resolveCname(name: string): Promise<string[]>;
    resolveTxt(name: string): Promise<string[][]>;
  };
}

/** The record Prisma is about to look up. */
export type ExpectedRecord =
  | { readonly type: "CNAME"; readonly name: string }
  | { readonly type: "TXT"; readonly name: string; readonly value: string };

/**
 * Prisma checks a domain's records through a caching resolver: a lookup that
 * races a just-published record caches NXDOMAIN for the zone's SOA minimum
 * (30 minutes on Cloudflare), failing every retry. Wait (bounded) until
 * every authoritative nameserver answers the record, plus a margin for
 * anycast edges we cannot see. Proceeds regardless, so a missing record
 * still surfaces Prisma's own error.
 *
 * `margin: "if-unseen"` skips the margin when the first check already sees
 * the record, i.e. it was published before this deploy reached it.
 */
export const waitForAuthoritativeRecord = (
  record: ExpectedRecord,
  options: { readonly margin: "always" | "if-unseen" },
) =>
  Effect.gen(function* () {
    const dns = yield* Effect.tryPromise(
      () => import("node:dns/promises") as unknown as Promise<NodeDns>,
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (dns === undefined || typeof dns.Resolver !== "function") return;
    const labels = record.name.split(".");
    let servers: string[] = [];
    for (let i = 1; i < labels.length - 1 && servers.length === 0; i++) {
      const names = yield* Effect.tryPromise(() => dns.resolveNs(labels.slice(i).join("."))).pipe(
        Effect.orElseSucceed(() => [] as string[]),
      );
      const addresses = yield* Effect.forEach(
        names,
        (name) =>
          Effect.tryPromise(() => dns.resolve4(name)).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          ),
        { concurrency: "unbounded" },
      );
      servers = addresses.flat();
    }
    if (servers.length === 0) return;
    const answeredBy = (server: string) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const instance = new dns.Resolver();
          instance.setServers([server]);
          return instance;
        });
        if (record.type === "CNAME") {
          const answers = yield* Effect.tryPromise(() => resolver.resolveCname(record.name));
          return answers.length > 0;
        }
        const answers = yield* Effect.tryPromise(() => resolver.resolveTxt(record.name));
        return answers.some((chunks) => chunks.join("") === record.value);
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.orElseSucceed(() => false),
      );
    const check = Effect.forEach(servers, answeredBy, { concurrency: "unbounded" }).pipe(
      Effect.map((seen) => seen.every(Boolean)),
    );
    const seenAtOnce = yield* check;
    if (seenAtOnce && options.margin === "if-unseen") return;
    const visible =
      seenAtOnce ||
      (yield* check.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (seen) => seen,
          times: 20,
        }),
      ));
    if (visible) yield* Effect.sleep("10 seconds");
  });
