import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  Bucket,
  ORPHAN_GRACE,
  RegistryConfig,
  SWEEP_LOOKAHEAD,
  tarballKey,
} from "./Bindings.ts";
import * as GitHub from "./GitHub.ts";
import * as Tags from "./Tags.ts";

/**
 * Expiry sweep. Tags tied to pull requests are extended while any of those
 * pull requests is open and pinned to the latest close time plus TTL once
 * they all close. Expired tags go away, and tarballs nothing points at are
 * deleted from R2.
 */
export const sweep = Effect.gen(function* () {
  const { policy } = yield* RegistryConfig;
  const r2 = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
  const github = yield* GitHub.GitHubApp;

  const now = yield* Clock.currentTimeMillis;
  const ttl = Duration.toMillis(policy.ttl);
  const due = yield* Tags.dueLinked(now + Duration.toMillis(SWEEP_LOOKAHEAD));

  // One lookup per pull request across every due row. `undefined` means the
  // pull request is still open; a failed lookup leaves the row alone.
  const closedAt = new Map(
    yield* Effect.forEach(
      new Set(due.flatMap((row) => row.linked_prs)),
      (ref) => {
        const [repo, number] = ref.split("#");
        return github.getPullRequest(repo!, Number(number)).pipe(
          Effect.map(
            (pr) =>
              [
                ref,
                pr.state === "open"
                  ? undefined
                  : Date.parse(pr.merged_at ?? pr.closed_at ?? "") || now,
              ] as const,
          ),
          Effect.catch((e) =>
            Effect.logWarning(
              `pull request ${ref} lookup failed: ${GitHub.describe(e)}`,
            ).pipe(Effect.as(undefined)),
          ),
        );
      },
      { concurrency: 4 },
    ).pipe(Effect.map((entries) => entries.filter((e) => e !== undefined))),
  );
  const extended = yield* Effect.forEach(due, (row) => {
    const refs = row.linked_prs.filter((ref) => closedAt.has(ref));
    // Open pull requests dominate; otherwise the latest close wins.
    const anchor = refs.some((ref) => closedAt.get(ref) === undefined)
      ? now
      : Math.max(...refs.map((ref) => closedAt.get(ref)!));
    const expiresAt = anchor + ttl;
    return refs.length === 0 || expiresAt === row.expires_at
      ? Effect.succeed(false)
      : Tags.setExpiry(row.package, row.tag, expiresAt).pipe(Effect.as(true));
  }).pipe(Effect.map((changed) => changed.filter(Boolean).length));

  const removed = yield* Tags.deleteExpired(now);
  const referenced = yield* Tags.referencedTarballs();
  const unreferenced = removed.filter(
    ({ package: pkg, sha256 }) => !referenced.has(`${pkg}/${sha256}`),
  );
  yield* Effect.forEach(
    unreferenced,
    ({ package: pkg, sha256 }) => r2.delete(tarballKey(pkg, sha256)),
    { discard: true },
  );

  // Uploads that never got tagged.
  const orphans = yield* Stream.paginate(
    undefined as string | undefined,
    (cursor) =>
      r2
        .list({ cursor, limit: 500 })
        .pipe(
          Effect.map(
            (page) =>
              [
                page.objects,
                page.truncated ? Option.some(page.cursor) : Option.none(),
              ] as const,
          ),
        ),
  ).pipe(
    Stream.filter((object) => {
      const match = object.key.match(/^(.+)\/([a-f0-9]{64})\.tgz$/);
      return (
        match !== null &&
        !referenced.has(`${decodeURIComponent(match[1]!)}/${match[2]}`) &&
        object.uploaded.getTime() < now - Duration.toMillis(ORPHAN_GRACE)
      );
    }),
    Stream.mapEffect((object) => r2.delete(object.key)),
    Stream.runCount,
  );
  yield* Effect.logInfo(
    `sweep: ${due.length} due, ${extended} extended, ${removed.length} tags expired, ${unreferenced.length + orphans} tarballs deleted`,
  );
});
