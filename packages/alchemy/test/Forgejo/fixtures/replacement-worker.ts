import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Forgejo from "@/Forgejo/index.ts";
import { RepositoryEventSourceCloudflare } from "alchemy/Forgejo/RepositoryEventSourceCloudflare";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Repository } from "./repository.ts";

export default class ReplacementWorker extends Cloudflare.Worker<ReplacementWorker>()(
  "ReplacementWorker",
  Effect.gen(function* () {
    const name = yield* Config.String("FORGEJO_HOST_NAME").pipe(
      Config.withDefault(undefined),
    );
    return { main: import.meta.url, name };
  }),
  Effect.gen(function* () {
    const repo = yield* Repository;
    const read = yield* Forgejo.ReadRepository(repo);
    const issues = yield* Forgejo.WriteIssues(repo);
    yield* Forgejo.RepositoryEventSource(
      repo,
      { events: ["issues"] },
      (event) =>
        event.payload.action === "opened"
          ? issues
              .createComment({
                index: event.payload.issue.number,
                body: "replacement delivered",
              })
              .pipe(Effect.asVoid, Effect.orDie)
          : Effect.void,
    );
    return {
      fetch: read
        .get()
        .pipe(Effect.orDie, Effect.flatMap(HttpServerResponse.json)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Forgejo.ReadRepositoryHttp,
        Forgejo.WriteIssuesHttp,
        RepositoryEventSourceCloudflare,
      ),
    ),
  ),
) {}
