/**
 * Eyeball fixture: open this file with the extension linked and every prose
 * body below should read as Markdown, while the surrounding TypeScript keeps
 * its normal colors. `Redacted.make(...)` at the bottom must stay untouched.
 */
declare const AI: {
  prose: (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
  say: (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
  Tool: (name: string) => (t: TemplateStringsArray) => unknown;
  Parameter: (
    name: string,
    schema: unknown,
  ) => (t: TemplateStringsArray) => unknown;
  Dispatch: (
    target: unknown,
    name: string,
  ) => (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
  Event: (
    name: string,
    payload: Record<string, unknown>,
  ) => (t: TemplateStringsArray) => new () => unknown;
};
declare const Parameter: (name: string, props: unknown) => unknown;
declare const Coding: {
  make: (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
};
declare const Redacted: { make: (value: string) => string };
declare const Schema: {
  Int: unknown;
  optionalKey: (schema: unknown) => unknown;
  check: (schema: unknown, min: number, max: number, unit: string) => unknown;
};
declare const Grep: unknown;

export const CodingLive = Coding.make`
  # Writing code in the repository checkout

  With ${Grep} in hand, the discipline the tools cannot carry alone:

  - **Read before you edit** — the digest chain exists so you never change a
    version you have not seen.
  - Verify with the test suite; the suite is the oracle of done-ness.

  > A reconcile is ONE flow: observe, ensure, sync, return.

  Canonical shapes live in \`AWS/S3/Bucket.ts\` and \`AWS/SQS/Queue.ts\`.

  \`\`\`typescript
  reconcile: Effect.fn(function* ({ news, output }) {
    const observed = yield* getQueue(name); // one flow, three starting points
    return yield* readAttributes(name);
  })
  \`\`\`

  A tilde fence needs no escaping, and reads the same to the model:

  ~~~sh
  bun run test test/AWS/SQS --profile testing
  ~~~

  | Don't | Do |
  | --- | --- |
  | \`await fetch(...)\` | \`HttpClient\` |
`;

export const stance = AI.prose`
  You are reviewing a pull request. Say what is *wrong*, not what is fine.
`;

export const note = AI.say`30 of 40 samplings spent — converge now.`;

/** Nested prose: indented past Markdown's three-space block limit. */
export const charter = () => {
  return () => {
    return AI.prose`
      ## Deeply indented

      1. The margin belongs to the code, not to the document.
      2. Blocks still read as *blocks* out here.
    `;
  };
};

/** Call-tagged prose: the tag is a call rather than a member access. */
const task = AI.Parameter("task", String)`
  The work itself, standing alone — the issue reference and the
  acceptance criteria verbatim.`;

export const HandToEngineer = AI.Dispatch(Grep, "hand_to_engineer")`
  Hand one round of issue work to the engineer, with ${task} standing
  alone. It answers with the **pull request** reference.`;

/** A body ending in a parenthesis must still close, not reopen. */
export const bump = AI.Tool("bump")`Increment the counter (once)`;

/** …even when the line itself opens with something shaped like a call. */
export const risky = AI.Tool("risky")`
run(now)`;

/** A call whose arguments are spread over several lines is prose too. */
export const spread = AI.Parameter(
  "spread",
  Schema.optionalKey(Schema.check(Schema.Int, 1, 3600, "seconds")),
)`
  Prose reached past the argument list.`;

/** The arguments keep their own colors, comments included. */
export class Wake extends AI.Event("Wake", {
  /** The cron fire time. */
  stamp: Schema.Int,
})`
A **scheduled** wake, described where the payload is declared.` {}

/** A call that only looks like a tag is handed back, arguments and all. */
export const notATag = Parameter("not-a-tag", {
  /** No template follows this one. */
  value: Redacted.make("not-prose"),
});

export const token = Redacted.make("not-prose");
