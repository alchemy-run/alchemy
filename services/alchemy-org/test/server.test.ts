/**
 * E2E composition smoke: the WHOLE org Layer graph — processes
 * (Issues, PullRequests), agents (Engineer, Reviewer), skills
 * (Coding), tools (GitHub bindings, local toolbox), kernel + model,
 * ledger, event polling — builds against real physics, the charters
 * interpret, the pollers register, and the sealed Shapes read the
 * real repository.
 *
 * Gated on the runtime credentials (`GITHUB_ACCESS_TOKEN`/`GITHUB_TOKEN`
 * and `ANTHROPIC_API_KEY`); without them the test skips.
 */
import * as GitHub from "alchemy/GitHub";
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Issues } from "../src/issues.ts";
import { PullRequests } from "../src/pull-requests.ts";
import { OrgLive } from "../src/server.ts";

/**
 * The GitHub Providers requirement is PHANTOM on this path: the org
 * resolves `testAlchemy`'s identity from its static owner/name props
 * (see RepositoryLike.resolveRepository), never through the provider
 * collection — same situation as the detached runtime, which provides
 * nothing for it either.
 */
const ProvidersPhantom = Layer.succeed(GitHub.Providers, undefined as never);

const hasCredentials =
  (process.env.GITHUB_ACCESS_TOKEN !== undefined ||
    process.env.GITHUB_TOKEN !== undefined) &&
  process.env.ANTHROPIC_API_KEY !== undefined;

test.skipIf(!hasCredentials)(
  "the org composes end-to-end and reads its world",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // the sqlite ledger needs its directory to exist
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(".alchemy", { recursive: true });

        yield* Effect.gen(function* () {
          const issues = yield* Issues;
          const pullRequests = yield* PullRequests;
          const [issueList, pullList] = yield* Effect.all([
            issues.list(),
            pullRequests.list(),
          ]);
          expect(Array.isArray(issueList)).toBe(true);
          expect(Array.isArray(pullList)).toBe(true);
        }).pipe(
          Effect.provide(OrgLive),
          Effect.provide(ProvidersPhantom),
          Effect.scoped,
        );
      }).pipe(Effect.provide(BunServices.layer), Effect.scoped),
    ),
  60_000,
);
