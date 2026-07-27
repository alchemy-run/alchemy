# alchemy-vscode

Highlights the body of alchemy prose templates as **Markdown** instead of as one
undifferentiated string.

A charter, skill, or note is written as a tagged template — the body is prose,
not code, and it reads like prose only if headings, emphasis, lists, and code
spans are colored like prose:

```ts
export const ResourceEngineeringLive = ResourceEngineering.make`
  # Writing resource providers

  A provider's reconcile is **ONE** flow that converges cloud state to the
  desired props:

  1. **OBSERVE** — derive the physical identifier; read live cloud state.
  2. **ENSURE** — if missing, create; catch \`AlreadyExists\` as a race.
`;
```

## What it matches

Two tag shapes. A member access ending in `make`, `prose`, or `say`:

| Matches             | Does not match        |
| ------------------- | --------------------- |
| ``Coding.make`…` `` | `Redacted.make(x)`    |
| ``AI.prose`…` ``    | ``make`…` ``          |
| ``AI.say`…` ``      | ``foo.makeThing`…` `` |

…and a **call** in tag position, whatever the callee is named:

```ts
AI.Tool("bash")`Run ${command} and return its exit code.`;
AI.Parameter("task", S.String)`The work itself, standing alone.`;
AI.Dispatch(Engineer, "hand_to_engineer")`Hand one round of work over.`;
class IssueOpened extends Event("IssueOpened", { issue })`An issue was opened.` {}
```

A call whose result is immediately used as a template tag is prose every time
it occurs here, so the call itself is the whole heuristic — no name list to
keep current. A plain call like `Redacted.make(value)`, with no backtick after
it, is untouched.

Arguments may span lines, which is how a payload schema is usually written:

```ts
export class Wake extends AI.Event("Wake", {
  /** The cron fire time. */
  stamp: S.String,
})`
A scheduled wake — one sync pass against upstream.` {}
```

Here the backtick is too far away to be the proof, so the callee is checked
against the prose constructors instead — `Agent`, `Dispatch`, `Event`,
`Kernel`, `Parameter`, `Prose`, `Skill`, `Thread`, `Tool`, with any receiver.
A new prose constructor goes in that list, in `#prose-multiline-call-template`.
A call that matches the list but has no template behind it — an SSM
`Parameter("id", {…})` resource, say — is released with its arguments
untouched.

Inside the body:

- headings, list bullets, blockquotes, table rows, and thematic breaks are
  recognized **at any indentation**, and inline markup (bold, italic,
  strikethrough, links, images) comes from VS Code's own Markdown grammar;
- fenced code blocks are highlighted in their own language — TypeScript,
  JavaScript, JSON, and shell are embedded, and anything else falls back to
  plain fence styling;
- `${Splice}` is highlighted as TypeScript, so term references still read as
  identifiers;
- `` \`code\` `` — the only way to spell an inline code span inside a template
  literal — is highlighted as a code span rather than as two escapes.

## Fences: prefer tildes

A template literal cannot contain a raw backtick, so a backtick fence has to be
escaped three times. Both forms work, and CommonMark treats them identically,
so the model reads the same document either way — but the tilde form is far
easier to write and to read in source:

```ts
AI.prose`
  ~~~ts
  const bucket = yield* Bucket("assets", {});
  ~~~

  \`\`\`ts
  const bucket = yield* Bucket("assets", {});
  \`\`\`
`;
```

Escapes inside a fence are still escapes: a code sample containing a template
literal writes `` \` ``, and those two characters are colored as an escape
rather than as part of the sample's string. A `${…}` inside a fence really is
interpolated at runtime, so it is highlighted as a splice, not as code.

## Install

```sh
bun run --filter alchemy-vscode link   # symlink into ~/.cursor|.vscode/extensions
```

Then run **Developer: Reload Window**. To produce a `.vsix` instead:

```sh
bun run --filter alchemy-vscode package
```

## Checking the highlighting

`scripts/inspect.ts` tokenizes a file with the real VS Code grammars plus this
injection, so scopes can be checked without launching an editor:

```sh
bun run --filter alchemy-vscode inspect                 # scopes for fixtures/sample.ts
bun run --filter alchemy-vscode check                   # assert the scopes that matter
bun scripts/inspect.ts ../../services/alchemy-org/src/Coding.ts
```

## How it works

`syntaxes/alchemy-prose.injection.json` is a TextMate injection grammar
(`injectTo: source.ts | source.tsx | source.js | source.js.jsx`). Five things
about it are load-bearing, and each one is a trap worth knowing before editing:

**The `begin` pattern swallows the whole tag** — the receiver chain, or the
entire call with its arguments. The `injectionSelector` carries the `L:`
prefix, which only wins a *tie* — the host's own tagged-template rule starts at
`Coding` in ``Coding.make`…` ``, so a pattern that started at the dot would
lose the race and never fire. The swallowed tag is handed back to `source.ts`
through a capture, so a call's arguments keep the colors they always had.

**Nothing may start at the far side of a closing paren.** The host closes its
function-call rule with a zero-width match immediately after the `)` — exactly
where a backtick-anchored pattern would begin. `L:` wins that tie too, and the
prize is a call rule that never closes and swallows the rest of the file as
call targets. Beginning at the callee sidesteps it: the host never opens a call
rule at all.

This is also why a call with multi-line arguments is *held open* from its
opening paren rather than picked up at its closing one. Holding it open means
owning the exit: the rule ends when the prose closes, when the call closes with
no template behind it, or when a line starts at the margin with something that
cannot be an argument — the third being what keeps a malformed file from
turning into one long claim.

**The injection switches itself off inside a prose body.** Injections are
consulted at every position, prose bodies included, and a paragraph is free to
contain something call-shaped — `run(now)` on its own line, ending the
paragraph. Left on, the call rule would read that as a tag and reopen the
template on its own closing backtick. Hence `-meta.embedded.block.alchemy-prose`
in the selector; prose nested in a `${…}` is matched by the splice rule
directly instead.

**Markdown is reached through a capture.** A TextMate rule only ever checks the
innermost rule's `end`, so a Markdown block rule pushed inside the template
would happily consume the closing backtick and everything after it — the rest
of the file becomes prose. Capture-scoped sub-tokenization is the only bounded
way to run another grammar, and every pattern handed to it stops at a backtick.

**Block constructs are re-implemented rather than borrowed.** Markdown's own
heading/list/quote rules are anchored to `^` with at most three spaces of
indent, and four spaces means an indented code block. A charter written inside
an `Effect.gen` is indented six — so borrowing them would render every nested
charter as raw text. The hand-rolled rules ignore the margin, mirroring what
the runtime's `dedentTemplate` strips. Only Markdown's *inline* rules, which
are position-independent, are borrowed as-is.

The same bounding applies inside a fence: each line of code goes to `source.ts`
(or `source.shell`, …) through a capture. Letting the language grammar run
unbounded is what breaks first — one escaped backtick in a sample opens a
TypeScript template literal that never closes, and it eats the rest of the
file.

## Known edges

- Because every line is tokenized independently, a construct that spans lines
  is not carried across them: a block comment or multi-line string inside a
  fence highlights per line, and a table's alignment row is styled without
  checking that a header precedes it. Setext headings and reference link
  definitions are not supported at all.
- Inline markup does not span a splice or a line break: `**bold ${x}**` loses
  its bold after the splice.
- A multi-line call is claimed on its opening line, before there is a template
  to prove it is prose, so its callee must be one of the names listed above.
  Any other multi-line call is left to the host grammar, and collapsing the
  call onto one line is the fix where it fits.
- A bare tag with no receiver (``make`…` ``) is not matched, and neither is an
  indexed one (``handlers[0]`…` ``).
- Changing the grammar requires a window reload; scope inspection lives under
  **Developer: Inspect Editor Tokens and Scopes**.
