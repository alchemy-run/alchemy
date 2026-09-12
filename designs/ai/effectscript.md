# EffectScript (`.fx`) — design sketch

A hypothetical dialect of TypeScript for Effect-native code (and therefore
for alchemy AI charters), designed by iterative rejection in conversation
(2026-07-22). Status: **design sketch — not scheduled**. The charter runtime
([spec.md](./spec.md)) neither needs nor knows about it; the dialect is pure
syntax over the shipped API.

## The thesis

Effect code is TypeScript with three ceremonies: `Effect.gen(function* ()
{...})`, `yield*`, and `.pipe(...)`. Because the dialect **bans `async` /
`Promise`** (Effect only), JavaScript's effect-adjacent syntax is free to be
retargeted, and the ceremonies disappear without inventing semantics. Every
construct maps 1:1 onto the existing runtime API; the transpiler is
concatenative; `tsc` on the output keeps all typing (including alchemy's
R-channel capability inference).

## The final surface

| syntax | compiles to | notes |
|---|---|---|
| `*{ ... }` | `Effect.gen(function* () { ... })` | an Effect **value** (the effect literal) |
| `function* name(x) {...}` | `const name = Effect.fn("name")(function* (x) {...})` | generator morphology retargeted — **near-identity transpile**; span from the name |
| `*method() {...}` | `method: Effect.fn("method")(...)` | already-valid JS generator-method syntax, retargeted |
| `*(x) => {...}` | `Effect.fn(function* (x) {...})` | the generator arrow TC39 never shipped |
| `*() => expr` | `Effect.fn(function* () { return expr })` | expression body **lifts pure values** — replaces `() => Effect.succeed(...)` |
| `*e` (prefix, operand position) | `yield* e` | the bind operator — see below |
| `throw e` (an EXPRESSION, type `never`) | effect context: `yield* Effect.fail(e)`; plain context: JS throw | TC39 throw-expressions grammar; composes in `??`, ternaries, arrow bodies |
| `a \|> f` | `f(a)` | F#-style application; Effect's data-last combinators are pipe-ready |
| everything else | untouched | templates, types, classes, `Match`, Layers |

Effect-function rules:

- **Plain arrows stay** for bodies that already ARE effects —
  `(e) => issues.settle(key, e)` returns an Effect unmarked; `*` forms are
  for bodies that *sequence* (contain `*` binds) or *lift* (pure values).
- **Double-wrap lint**: `*() => someEffect` is `Effect<Effect<…>>` — an
  effect-typed expression body inside a `*` arrow without a deref is an
  error ("drop the `*` or bind inside").
- `*` means wrap or unwrap **by shape**: followed by a block or params
  (`*{ }`, `*() =>`, `*method()`) it CONSTRUCTS an effect; followed by an
  expression (`*e`) it BINDS one. One symbol, direction from what follows
  — the same duality generators already carry (`function*` declares,
  `yield*` delegates). Style note: `return *{ … }` (return the effect)
  and `return *e` (bind, return the value) read as opposites — prefer
  naming inner effects (`const turn = *{ … }; return turn`) when the
  adjacency bites.
- **Raw generators (Iterable protocol) have no spelling in `.fx`** —
  their main Effect-codebase use was `Effect.gen` bodies, which this
  deletes. Escape: author them in a `.ts` module. Stream syntax
  (`stream function*`?) is a future question, no longer a reserved form.

**Everything is an expression.** `throw` follows the TC39
throw-expressions grammar (unary, type `never`, `throw a ?? b` throws
`(a ?? b)`), so failure composes anywhere a value goes — and a whole turn
can be one expression:

```ts
Effect.catchTag("Timeout", *() => throw new AI.Refused({ loop: key, reason: "provider timeout" }))

const pr = (*find({ citing: key })) ?? throw new NotFound(key)

return (*AI.Tick).count >= 40
  ? throw new AI.Refused({ loop: `Engineer(${key})`, reason: "40 samplings without green" })
  : *AI.prose`…`
```

Statements exist only inside `*{ }` blocks, as sequencing sugar.

Deliberately absent:

- **No `try`/`catch`/`finally`.** Error handling and resource safety are
  purely functional, via pipe: `\|> Effect.catchTag(...)`,
  `\|> Effect.ensuring(...)`, `Effect.acquireRelease` (which is the *better*
  resource idiom — interruption-safe — that a lexical `try/finally` would
  have crowded out). One family, one spelling.
- **No `state` / `tool` / prose keywords.** State is `Ref`; tools and prose
  are the library's tagged templates. (See "the arc" for why.)
- **No type-position changes.** Only value syntax is retargeted;
  annotations still spell `Effect.Effect<A, E, R>`.

## The bind operator: `*`

Prefix `*` dereferences a description to its value — OCaml's `let*` and
Rust's `?`-frequency argument (the most frequent operation earns the
shortest spelling):

```ts
const { key } = *AI.Thread
const { status } = *ledger.offer("issues", JSON.stringify(event), event)
return *AI.prose`…`
*issues.send(event, { key })            // bare statement: sequence for the effect
```

Rules:

- `await`-class precedence (unary, tight): `*e \|> f` pipes the **value**;
  to wrap the effect, parenthesize or name the pipeline first.
- Chaining needs parens, as `await` does today: `(*ledger.offer(...)).status`.
- Lexer carve-outs (whitespace-sensitive): `a**b` is exponentiation, `a * *b`
  multiplies by a bound value; in Stream generators `yield* x` delegates,
  `yield *x` yields a bound value.
- Runner-up spelling: `run e` (greppable, self-teaching, four chars). The
  decision is aesthetic identity; **do not ship both**.

## Pipe style

```ts
const offer = ledger.offer("issues", id, event)
  |> Effect.catchTag("GitHubApiError", () => Effect.succeed({ status: "duplicate" as const }))
  |> Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") })
  |> Effect.withSpan("issues.offer")

const { status } = *offer
```

- Newline-before-`|>` continues the statement (ASI carve-out, same class as
  the `*`/`run` operand rule).
- House style: **name pipelines, then bind** — each line stays in one
  precedence world.
- `|>` is general (any data-last function), so it pays across
  `Array.map`/`Schema`/etc., not just effects.

## The charters, in full

`engineer.fx`:

```ts
import * as AI from "alchemy/AI"
import { Coding } from "./coding"
import { OpenPullRequest } from "./tools"
import { issue } from "./vocabulary"

export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

export const EngineerCharter = *{                // INIT — once per run
  const { key } = *AI.Thread

  return *{                                      // TURN — per tick
    if ((*AI.Tick).count >= 40) {
      throw new AI.Refused({
        loop: `Engineer(${key})`,
        reason: "40 samplings without reaching green",
      })
    }
    return *AI.prose`
      You receive exactly one ${issue} whose acceptance criteria are your
      entire specification. ${Coding} is your craft; all tests green is
      the only definition of done you may use. When green,
      ${OpenPullRequest} citing the issue.

      You do not review your own work, and you do not merge.
    `
  }
}

export const EngineerLive = AI.layer(Engineer, EngineerCharter)
```

`issues.fx` (charter + wiring):

```ts
const charter = *{
  const phase = *Ref.make<"triaging" | "awaiting-author">("triaging")

  const awaitAuthor = AI.Tool("await_author")`
    Park this issue on its author. Ask with ${Comment} first — one per
    gap — then call this.
  `(*() => {
    *Ref.set(phase, "awaiting-author")
    return "parked; the author's next reply resumes this issue"
  })

  const resumeTriage = AI.Tool("resume_triage")`
    The author's reply closed the gaps.
  `(*() => {
    *Ref.set(phase, "triaging")
    return "resumed"
  })

  const triaging = AI.prose`
    Every ${GitHub.IssueOpened} is checked for prior art with
    ${SearchIssues}. Duplicates: ${LinkIssues}, ${Comment}, ${CloseIssue}.
    Until ready, ${Comment} asks and ${awaitAuthor} parks the issue.
    A ready issue is handed to ${Engineer}.
  `
  const parked = AI.prose`
    This issue is parked on its author. Judge their latest reply: when it
    closes the gaps, ${resumeTriage}; otherwise ask again with ${Comment}.
  `

  return *{
    return *AI.prose`
      This process manages GitHub issues for ${testAlchemy} from open to
      close. No code is written here and nothing merges here.

      ${(*Ref.get(phase)) === "triaging" ? triaging : parked}

      A merged fix closes its issue with ${CloseIssue}, citing the pull request.
    `
  }
}

export const IssuesLive = Layer.effect(Issues, *{
  const ledger = *Ledger
  const listIssues = *GitHub.ListIssues(testAlchemy)
  const issues = *AI.actor(Issues, charter)

  function* route(event: GitHub.IssuesEvent | GitHub.IssueCommented) {
    const key = GitHub.eventKey(event)!
    const { status } = *ledger.offer("issues", JSON.stringify(event), event)
    if (status === "duplicate") return
    *Match.value(event).pipe(
      Match.tag("IssueClosed", (e) => issues.settle(key, e)),
      Match.orElse((e) => issues.send(e, { key })),
    )
  }

  *GitHub.consumeRepositoryEvents(testAlchemy, {
    events: [GitHub.IssueOpened, GitHub.IssueCommented, GitHub.IssueClosed],
  }, route)

  return { list: () => listIssues({ state: "open" }) }
})
```

Template-splice rule: `*` inside a splice is **eager** — hoisted to the
enclosing effect context (correct inside a turn, which re-runs per tick);
for lazy/per-tick evaluation of prose built in init, splice an explicit
`*{ }` block (the renderer already re-evaluates Effect splices per
render).

## Grammar & tooling notes

- `*{` in operand position is unambiguously the effect literal (deref of
  an object literal is meaningless, and `a * {}` multiplication-by-object
  is nonsense the grammar need not preserve). The dialect has **zero
  keywords** — its entire surface is `*`, `|>`, and expression-`throw`.
- `*`'s operand grammar follows unary minus; ASI rules are `yield`-class
  (no line break between operator and operand). `*(params) =>` needs
  cover-grammar lookahead to distinguish from multiplication-by-
  parenthesized (the same machinery TS uses for arrow-vs-parens); in
  operand position (after `,`, `(`, `=`, statement start) it is
  unambiguous. `function*` declarations transpile to `const` bindings —
  they no longer hoist; a lint flags use-before-declaration.
- The dialect leaves stock grammar (`*{ }`, `*() =>`, `|>`): a real
  parser and Volar-based editor tooling from day one. (The `async`
  variant parsed everywhere for free but silently shadowed live JS
  semantics — rejected for exactly that.)
- Transpile is concatenative with exact source maps; `tsc` type-checks the
  output. Never fork the TypeScript compiler (the ts-plus lesson).
- 90% of the "prose-first" feel is available **without any dialect**: a
  VSCode extension injecting markdown highlighting into `AI.prose`/tool
  templates (the styled-components mechanism).

## Implementation (no forks)

The compiler's integration boundary is SOURCE TEXT, not AST — both
`tsserver` and tsgo ingest programs through text snapshots and parse with
their own parsers (synthesized AST injection is unsupported and, for tsgo's
Go process boundary, impossible). So the architecture is one pipeline with
text as the wire format between the two compilers:

```
.fx source → our parser → .fx AST → TS text + per-node source maps
  → in-memory snapshot → TS compiler parses/checks → results mapped back
```

Because emit is near-identity, diagnostic spans land verbatim in user code;
wrapper-owned positions (the `Effect.gen(function* () {` prelude) pin to
the construct token (`*{`).

| concern | seam (all supported, no forks) |
|---|---|
| transpiler | hand-written recursive-descent, VENDORING an existing TS parser's parser layer only (TS `parser.ts` or oxc) — never de novo (full TS grammar is a multi-year tax), never tree-sitter (editor tool, can't carry cover-grammar lookahead) |
| runtime | `Bun.plugin` `onLoad` over `.fx`, registered via `bunfig.toml` `preload` (covers `bun run` + `bun test`); Node `module.register` hooks; Vite/esbuild via unplugin — one core, four loaders |
| `fx check` | proxied `CompilerHost` serving virtual `.fx.ts` snapshots (the `vue-tsc` pattern; `@volar/typescript` ships `proxyCreateProgram`); diagnostics remapped through source maps |
| `fx check --engine tsgo` | verified against the source (2026-07, `.vendor/typescript-go`): all compiler code is Go-`internal/` (in-process embedding impossible by language rule — forking would be the only way in, hence: don't), BUT tsgo ships a sanctioned seam: `tsgo --api` stdio server + the `@typescript/native-preview` JS client (`Project`/`Program.getSemanticDiagnostics`/`Checker`), with **client-provided virtual-FS callbacks** (`options.fs`, `createVirtualFileSystem`; Go side: `internal/api/callbackfs.go`) — serve transpiled `.fx.ts` fully in-memory, remap diagnostics. `API.fromLSPConnection` (`custom/initializeAPISession`) is the future corridor for backing the language server with tsgo. No plugin system exists in its LSP (confirmed), so our own LS stays the editor architecture. Caveat: the package is literally `native-preview` — pin versions, expect churn, keep the TS 5.x LS path during the preview period |
| language server | Volar `LanguagePlugin` producing `VirtualCode` (TS text + mappings); Volar owns virtual docs, bidirectional mapping, and drives the real TS language service — one program spans `.fx` and `.ts` (cross-file rename/references work). Note: classic tsserver plugins CANNOT add file extensions — that limitation is why Volar exists |
| highlighting | TextMate grammar + semantic tokens from our parser; markdown injection into `AI.prose`/tool templates rides along |
| debugging | inline source maps in transpiled output; Bun maps stacks natively |
| publishing | `.fx` never ships: `fx build` emits `.ts`/`.js` + `.d.ts`; consumers need zero toolchain |

Staging: (1) transpiler spike + snapshot tests over this doc's two examples;
(2) Bun preload; port one org charter to `.fx` and run its existing
scripted-model test through it — the suite is the transpiler's oracle;
(3) `fx check`; (4) Volar LS + grammar; (5) formatter (deferred);
(6) native tsgo integration only after the dialect is stable AND upstream
has settled — as a patch-set, never a divergent fork (the ts-plus lesson;
and tsgo's pre-parity flux makes now the worst moment in TS history to
fork it).

Existence proof for the whole stack: **Civet** (TS-superset dialect —
hand-written parser → TS text, Bun/Vite/esbuild loaders, Volar LS,
TextMate grammar), plus Vue/Astro/MDX at millions-of-users scale for the
language-server pattern.

## The arc (rejected designs, and why)

1. **Markdown-host (MDX-inverted)** — prose file with `ts init`/`ts tick`
   fences. Rejected: charters are 50–60% structure; when most of the
   document is code fences, the host is wrong.
2. **Custom directives** (`state`, `guard`, `::: when`, `### tool`) —
   rejected: invented semantics; everything must stay expressible as
   ordinary Effect (loops, Layers, composition).
3. **`"""` prose literals** — rejected: interpreter dispatch for literals
   *is* tagged template literals; TS already has the right design.
4. **`do {}` as the modifier** — superseded by `async` (stock parse), then
   both superseded by `effect` (no semantic shadowing; definition sites
   announce the dialect).
5. **`await` as bind** — rejected: implies suspension; effects can be
   synchronous. → `run` → `*`.
6. **`try/catch/finally`** (statement, then expression form) — rejected:
   two syntaxes for one thing; error handling and resource safety are
   pipe-only, and `acquireRelease` beats lexical `finally` anyway.
7. **`effect` as a keyword** (function modifier, then block literal) —
   eliminated entirely by generator morphology: `function*`, `*method()`,
   `*() =>` for functions (near-identity to the existing
   `Effect.gen`/`Effect.fn` machinery — migration = deleting the wrapper;
   `*() => expr` lifts pure values, deleting `Effect.succeed` at call
   sites), and `*{ }` for the effect literal. The wrap/unwrap duality of
   `*` (construct when a block/params follow, bind when an expression
   follows) is the same duality generators already carry (`function*`
   declares, `yield*` delegates); a style rule covers the one adjacency
   that reads poorly (`return *{…}` — prefer naming inner effects).

## Open questions

1. `*` vs `run` — final aesthetic call (density + OCaml/Rust precedent vs
   greppability). One spelling only.
2. ~~Keep `throw`?~~ **Resolved: kept, as an expression** (TC39
   throw-expressions shape) — it introduces failures on the sequencing
   side and creates no second handling syntax; handling remains pipe-only.
3. Stream syntax: `function*` now means effect-fn, so generator-shaped
   Streams need a future form (`stream function*`? `yield` as emit,
   `for (const x of *stream)` as consumption) — design when Streams show
   up in charters. Until then, Stream combinators (library) only.
4. Tool-definition ergonomics (`AI.Tool(name)`desc`(impl)` currying) — a
   library question, not syntax; revisit independently.
