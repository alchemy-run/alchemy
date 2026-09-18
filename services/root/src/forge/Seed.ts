/**
 * SEEDING the forge — the org's repositories, mirrored in.
 *
 * Each seed is one repository import from the public GitHub URL: the
 * server's import job speaks smart HTTP as a client, ingests the
 * pack like a push, and the repo flips `importing → ready`. v1
 * imports are DEPTH-LIMITED (the engine caps ingested packs at
 * 50 MiB; full history arrives later via a push-mirror from a real
 * clone — the deploy story), which is exactly enough for the
 * isolated loop: branches, HEAD content, clones, new work on top.
 *
 * Idempotent by construction: an existing repo is left alone, so the
 * seed route can be hit any time.
 */
import { Engine } from "alchemy/Git";
import * as Effect from "effect/Effect";

export interface SeedSpec {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  /** Restrict the import to one branch — an all-refs depth-1 pack of
   *  the big repos exceeds the cap; one branch tip fits. */
  readonly ref?: string;
  /** Depth-limit the imported history (v1 pack cap: 50 MiB). */
  readonly depth: number;
  /** Raise the pack cap for this seed (bytes) — dev hosts can afford
   *  it; DEPLOYED instances seed by push-mirror instead (the plan's
   *  Phase 6), so this never buffers inside a real Durable Object. */
  readonly maxPackBytes?: number;
}

/** The org's mirrors — alchemy and its sibling repositories. */
export const SEEDS: ReadonlyArray<SeedSpec> = [
  {
    owner: "org",
    name: "alchemy",
    url: "https://github.com/alchemy-run/alchemy.git",
    ref: "main",
    depth: 1,
  },
  {
    owner: "org",
    name: "distilled",
    url: "https://github.com/alchemy-run/distilled.git",
    ref: "main",
    depth: 1,
    // distilled's generated SDK sources pack to ~101 MiB at depth 1
    maxPackBytes: 128 * 1024 * 1024,
  },
  {
    owner: "org",
    name: "floci",
    url: "https://github.com/alchemy-run/floci.git",
    ref: "main",
    depth: 1,
  },
];

export interface SeedReport {
  readonly repo: string;
  /** `importing | ready | failed | exists | absent`. */
  readonly status: string;
}

/** Kick every missing seed's import; answer each repo's status. */
export const seed = Effect.gen(function* () {
  const engine = yield* Engine;
  const reports: Array<SeedReport> = [];
  for (const spec of SEEDS) {
    const existing = yield* engine.repositories
      .get({ owner: spec.owner, repo: spec.name })
      .pipe(Effect.catchTag("RepoNotFound", () => Effect.succeed(undefined)));
    if (existing !== undefined) {
      reports.push({
        repo: `${spec.owner}/${spec.name}`,
        status: existing.status,
      });
      continue;
    }
    const started: string = yield* engine.repositories
      .import({
        owner: spec.owner,
        name: spec.name,
        source: {
          url: spec.url,
          ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
          depth: spec.depth,
          ...(spec.maxPackBytes !== undefined
            ? { maxPackBytes: spec.maxPackBytes }
            : {}),
        },
      })
      .pipe(
        Effect.map((created) => created.repo.status as string),
        Effect.catchTag("RepoAlreadyExists", () => Effect.succeed("exists")),
      );
    // the mirrors are PUBLIC: anonymous clones, no credential
    yield* engine.repositories.get({ owner: spec.owner, repo: spec.name }).pipe(
      Effect.flatMap((repo) =>
        engine.repositories.update(repo, { public: true }),
      ),
      Effect.asVoid,
      Effect.catchCause(() => Effect.void),
    );
    reports.push({ repo: `${spec.owner}/${spec.name}`, status: started });
  }
  return reports;
});

/** The seeds' current statuses (no side effects). */
export const seedStatus = Effect.gen(function* () {
  const engine = yield* Engine;
  const reports: Array<SeedReport> = [];
  for (const spec of SEEDS) {
    const repo = yield* engine.repositories
      .get({ owner: spec.owner, repo: spec.name })
      .pipe(Effect.catchTag("RepoNotFound", () => Effect.succeed(undefined)));
    reports.push({
      repo: `${spec.owner}/${spec.name}`,
      status: repo?.status ?? "absent",
    });
  }
  return reports;
});
