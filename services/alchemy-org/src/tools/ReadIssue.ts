import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../Repos.ts";
import { issue } from "../Vocabulary.ts";

export class ReadIssue extends AI.Tool<ReadIssue>()("readIssue")`
Read ${issue} in full: its title, state, and body — the acceptance
criteria exactly as the author wrote them.` {}

/** `issues.get`, rendered as title + state + body. */
export const ReadIssueLive = Layer.effect(
  ReadIssue,
  Effect.gen(function* () {
    const getIssue = yield* GitHub.GetIssue(testAlchemy);
    return ((input: {
      issue: { owner: string; repository: string; number: number };
    }) =>
      getIssue({ issue_number: input.issue.number }).pipe(
        Effect.map((found) =>
          [
            `#${found.number} ${found.title} (${found.state})`,
            "",
            found.body ?? "(no description)",
          ].join("\n"),
        ),
        Effect.mapError((error) =>
          error._tag === "GitHub.IssueNotFound"
            ? `issue #${input.issue.number} does not exist`
            : `${error.operation} failed: ${error.message}`,
        ),
      )) as never;
  }),
);
