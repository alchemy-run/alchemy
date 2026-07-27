/**
 * Eyeball fixture: open this file with the extension linked and every prose
 * body below should read as Markdown, while the surrounding TypeScript keeps
 * its normal colors. `Redacted.make(...)` at the bottom must stay untouched.
 */
declare const AI: {
  prose: (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
  say: (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
};
declare const Coding: {
  make: (t: TemplateStringsArray, ...refs: unknown[]) => unknown;
};
declare const Redacted: { make: (value: string) => string };
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

export const token = Redacted.make("not-prose");
