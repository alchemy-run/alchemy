import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../repos.ts";
import { pattern } from "../vocabulary.ts";

export class SearchIssues extends AI.Tool<SearchIssues>()("searchIssues")`
Search issues and pull requests in the repository for ${pattern}.
Use before filing anything — duplicates are debt.` {}

/** Search issues + pull requests in the managed repository. */
export const SearchIssuesLive = Layer.effect(
  SearchIssues,
  Effect.gen(function* () {
    const search = yield* GitHub.SearchIssues(testAlchemy);
    return ((input: { pattern: string }) =>
      Effect.gen(function* () {
        const results = yield* search({
          q: input.pattern,
          per_page: 20,
        }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        if (results.items.length === 0) return "no matches";
        return results.items
          .map(
            (item) =>
              `#${item.number} [${item.state}${item.pull_request ? ", PR" : ""}] ${item.title}`,
          )
          .join("\n");
      })) as never;
  }),
);
