import * as AI from "@alchemy.run/ai";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Repo } from "./Repo.ts";

/** Hidden in every comment the bot posts, so it never answers itself. */
export const MARKER = "<!-- issue-bot -->";

/** Find issues and pull requests on the repository that mention some words. */
export class SearchIssues extends AI.Tool<SearchIssues>()("search_issues", {
  description:
    "Search this repository's issues and pull requests. Use it to find duplicates or related work.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({
    issues: Schema.Array(
      Schema.Struct({ number: Schema.Number, title: Schema.String, state: Schema.String }),
    ),
  }),
}) {}

export const SearchIssuesLive = SearchIssues.make(
  Effect.gen(function* () {
    const search = yield* GitHub.SearchIssues(yield* Repo);

    return Effect.fn(function* ({ query }) {
      const found = yield* search({ q: query, per_page: 10 }).pipe(Effect.orDie);
      return {
        issues: found.items.map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
        })),
      };
    });
  }),
).pipe(Layer.provide(GitHub.SearchIssuesHttp));
