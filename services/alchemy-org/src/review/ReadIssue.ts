import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { primary } from "../github/Repos.ts";

// S.Int, not S.Number: S.Number's JSON schema is a 4-way anyOf
// (number | "NaN" | "Infinity" | "-Infinity") and Anthropic hard-caps
// union-typed parameters per request (16) — a toolkit of refs blows
// through it. Issue numbers are integers anyway.
export const IssueRef = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Int,
});

export const issue = AI.Parameter("issue", IssueRef)`
A reference to a GitHub issue in the repository — the spec a pull
request cites ("Closes #N"), whose acceptance criteria are the
review's rubric.`;

export class ReadIssue extends AI.Tool<ReadIssue>()("readIssue")`
Read ${issue} in full: its title, state, and body — the acceptance
criteria exactly as the author wrote them.` {}

/** `issues.get`, rendered as title + state + body. */
export const ReadIssueLive = Layer.effect(
  ReadIssue,
  Effect.gen(function* () {
    const getIssue = yield* GitHub.GetIssue(primary);
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
