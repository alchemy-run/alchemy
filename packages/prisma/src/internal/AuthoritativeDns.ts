import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/** The record Prisma is about to look up. */
export type ExpectedRecord =
  | { readonly type: "CNAME"; readonly name: string; readonly value?: string }
  | { readonly type: "TXT"; readonly name: string; readonly value: string };

/**
 * `seen`: every authoritative nameserver returns the record. `absent`: one
 * answered without it. `unknown`: none could be found or reached.
 */
export type RecordVisibility = "seen" | "absent" | "unknown";

class DnsQueryFailed extends Data.TaggedError("DnsQueryFailed")<{
  readonly code: string | undefined;
}> {}

/** Resolver error codes for an answer that does not hold the record. */
const NEGATIVE_ANSWERS = new Set(["ENODATA", "ENOTFOUND"]);

const combine = (answers: ReadonlyArray<RecordVisibility>): RecordVisibility =>
  answers.every((answer) => answer === "seen")
    ? "seen"
    : answers.includes("absent")
      ? "absent"
      : "unknown";

/**
 * Prisma checks a domain's records through a caching resolver: a lookup that
 * races a just-published record caches NXDOMAIN for the zone's SOA minimum
 * (30 minutes on Cloudflare), failing every retry. Wait (bounded) while
 * the authoritative nameservers answer without the record, then add a margin
 * for anycast edges we cannot see once every one returns it.
 *
 * `margin: "if-unseen"` skips the margin when the first check already sees
 * the record, i.e. it was published before this deploy reached it.
 */
export const waitForAuthoritativeRecord = (
  record: ExpectedRecord,
  options: { readonly margin: "always" | "if-unseen" },
): Effect.Effect<RecordVisibility> =>
  Effect.gen(function* () {
    const dns = yield* Effect.tryPromise(() => import("node:dns/promises")).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (dns === undefined || typeof dns.Resolver !== "function") return "unknown";
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
    if (servers.length === 0) return "unknown";
    const answerOf = (server: string) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const instance = new dns.Resolver();
          instance.setServers([server]);
          return instance;
        });
        const lookup = (query: () => Promise<ReadonlyArray<unknown>>) =>
          Effect.tryPromise({
            try: query,
            catch: (error) =>
              new DnsQueryFailed({
                code:
                  Predicate.hasProperty(error, "code") && typeof error.code === "string"
                    ? error.code
                    : undefined,
              }),
          }).pipe(
            // A timed-out query keeps retrying in c-ares unless cancelled.
            Effect.onInterrupt(() => Effect.sync(() => resolver.cancel())),
          );
        const found =
          record.type === "CNAME"
            ? (yield* lookup(() => resolver.resolveCname(record.name))).some(
                (target) =>
                  record.value === undefined ||
                  (typeof target === "string" &&
                    target.replace(/\.$/, "").toLowerCase() === record.value.toLowerCase()),
              )
            : (yield* lookup(() => resolver.resolveTxt(record.name))).some(
                (chunks) => Array.isArray(chunks) && chunks.join("") === record.value,
              );
        return found ? ("seen" as const) : ("absent" as const);
      }).pipe(
        Effect.catchTag("DnsQueryFailed", (error) =>
          Effect.succeed(
            error.code !== undefined && NEGATIVE_ANSWERS.has(error.code)
              ? ("absent" as const)
              : ("unknown" as const),
          ),
        ),
        Effect.timeout("3 seconds"),
        Effect.orElseSucceed(() => "unknown" as const),
      );
    const check = Effect.forEach(servers, answerOf, { concurrency: "unbounded" }).pipe(
      Effect.map(combine),
    );
    const first = yield* check;
    if (first === "seen" && options.margin === "if-unseen") return first;
    const visibility =
      first === "absent"
        ? yield* check.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (answer) => answer !== "absent",
              times: 20,
            }),
          )
        : first;
    if (visibility === "seen") yield* Effect.sleep("10 seconds");
    return visibility;
  });

/** The authoritative check `Prisma.DomainOwnership` runs before it creates anything. */
export const AuthoritativeRecordCheck = Context.Reference<typeof waitForAuthoritativeRecord>(
  "@alchemy.run/prisma/AuthoritativeRecordCheck",
  { defaultValue: () => waitForAuthoritativeRecord },
);
