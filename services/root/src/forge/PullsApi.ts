/**
 * The PULL DIFF door — `GET /api/forge/repos/:owner/:repo/pulls/:number/diff`
 * answers the pull request's unified diff as text.
 *
 * v1 sources it from GitHub (`Accept: application/vnd.github.diff`,
 * the org's token) for MIRRORED pulls — the same trust boundary as
 * Sync.ts: display data for GitHub-born objects. A pull born on the
 * forge itself (the Phase-4 loop) will serve from the embedded
 * server's own compare instead.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PublishToken } from "../github/PublishToken.ts";
import { Issues } from "./Issues.ts";
import { MIRRORS } from "./Sync.ts";

export const PullsApi = Effect.gen(function* () {
  const issues = yield* Issues;
  const publishToken = yield* PublishToken;

  /** The item's TIMELINE — commits, reviews, close/merge/label
   *  events — proxied from GitHub for mirrored items (paged, merged
   *  into one array); a forge-born item has no upstream, so its
   *  timeline is just its local comments (an empty array here). */
  const timeline = HttpRouter.add(
    "GET",
    "/api/forge/repos/:owner/:repo/issues/:number/timeline",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const repo =
        `${String(params.owner)}/${String(params.repo)}`.toLowerCase();
      const number = Number(params.number);
      const row = yield* issues.get(repo, number);
      const mirror = MIRRORS.find((entry) => entry.forge === repo);
      if (row === undefined) {
        return HttpServerResponse.jsonUnsafe(
          { message: "Not Found" },
          { status: 404 },
        );
      }
      if (row.origin !== "github" || mirror === undefined) {
        return yield* HttpServerResponse.json([]);
      }
      const token = Redacted.value(yield* publishToken);
      const client = yield* HttpClient.HttpClient;
      const events: Array<unknown> = [];
      for (let page = 1; page <= 3; page++) {
        const response = yield* client
          .get(
            `https://api.github.com/repos/${mirror.github}/issues/${number}/timeline?per_page=100&page=${page}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "user-agent": "root-forge",
              },
            },
          )
          .pipe(Effect.orDie);
        if (response.status !== 200) break;
        const batch = (yield* response.json.pipe(
          Effect.orDie,
        )) as Array<unknown>;
        events.push(...batch);
        if (batch.length < 100) break;
      }
      return yield* HttpServerResponse.json(events);
    }),
  );

  const diff = HttpRouter.add(
    "GET",
    "/api/forge/repos/:owner/:repo/pulls/:number/diff",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const repo =
        `${String(params.owner)}/${String(params.repo)}`.toLowerCase();
      const number = Number(params.number);
      const row = yield* issues.get(repo, number);
      if (row === undefined || !row.isPull) {
        return HttpServerResponse.jsonUnsafe(
          { message: "Not Found" },
          { status: 404 },
        );
      }
      const mirror = MIRRORS.find((entry) => entry.forge === repo);
      if (row.origin !== "github" || mirror === undefined) {
        // forge-born pulls serve from the embedded server (Phase 4)
        return HttpServerResponse.jsonUnsafe(
          { message: "no diff source for this pull yet" },
          { status: 501 },
        );
      }
      const token = Redacted.value(yield* publishToken);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .get(
          `https://api.github.com/repos/${mirror.github}/pulls/${number}`,
          {
            headers: {
              accept: "application/vnd.github.diff",
              authorization: `Bearer ${token}`,
              "user-agent": "root-forge",
            },
          },
        )
        .pipe(Effect.orDie);
      if (response.status !== 200) {
        return HttpServerResponse.jsonUnsafe(
          { message: `upstream ${response.status}` },
          { status: 502 },
        );
      }
      const text = yield* response.text.pipe(Effect.orDie);
      return HttpServerResponse.text(text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }),
  );

  return Layer.mergeAll(diff, timeline);
});
