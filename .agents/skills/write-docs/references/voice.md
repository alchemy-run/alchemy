# Voice

Docs speak to a developer doing a task: what to do and what they'll see. Write
one or two short lines, then a snippet, all the way down. Let the code speak.

## Sentences

- **Second person, present tense.** "Give production its own organization." Not
  "Users may wish to…", and not "we".
- **Instructions and observations, not internals.** Don't narrate what Alchemy
  does inside ("the adapter decides", "the engine reconciles", "synthesizes").
  Never call Alchemy "the engine". Say what the reader does and sees.
- **Never talk about the page itself.** No "This page introduces…", "This
  chapter starts with…", "the rest of this page explains…", "Each concept on
  this page…". Say the thing. A short repeat of the hub's introduction is better
  than a sentence about the page. Don't explain why a limitation exists, either.
- **Plain words.** create, not mint or provision. copy, not fork. give the Worker,
  not bind into. only works on, not scoped to. while it runs, not at runtime.
  cancel, not revoke (in prose; API names stay as they are).
- **State the thing plainly.** "A Resource is a cloud entity in a Stack." No
  "three ideas" framing, no "inert", no adjectives selling the feature.
- **Capitalize resource types used as proper nouns**: Bucket, Worker, Queue, KV
  Namespace, Machine.

## Shape

- **Prose, not bullets.** An explanatory bullet list becomes prose, or small
  headings each with its own snippet. Lists are fine for genuinely list-shaped
  things: prerequisites, a recap, a set of options.
- **No tables, except to map things** (a value to its meaning, an option to
  when to use it). Never use a table as the explanation.
- **Budget prose at a third of a first draft.** Cut reference minutiae. The
  generated reference page lists every prop.
- **Build ideas progressively.** Before writing a concept page, list the
  reader's questions in order and answer each with prose plus the smallest snippet.
- **Bold a term once, where it's defined.**
- **Callouts sparingly**: `:::note` for an end-of-section go-deeper link,
  `:::tip` for a minor aside. Never `:::caution` for something that's just a fact.
- **End sections with a link** when there's a deeper page: "See [Credentials](/planetscale/data/credentials)."

## Snippets

- **Whole runnable files** when a snippet has imports: no module-scope `yield*`,
  no `...` elisions, no `/* verify */` placeholders. Module scope declares
  (`export const Jobs = AWS.SQS.Queue("Jobs")`). `yield*` fragments without
  imports are fine when clearly inside an `Effect.gen`.
- **Pass declarations directly**: `sshKeys: [Key]`, `yield* AWS.S3.PutObject(Files)`.
  Don't `const x = yield* Foo` just to pass it on.
- **Provide one composed Layer once.** Never chain `Effect.provide`. A binding
  needs its client Layer provided (`AWS.SQS.SendMessageHttp`), so show it.
- **Read config through `Config`**: `Config.Redacted("API_KEY")`, never `process.env`.
- **Title code blocks with their file**: `title="alchemy.run.ts"`, `title="src/api.ts"`.
- **Diff blocks need a column-0 context line**, or the build's odd-indent check
  fails. Every `diff lang="typescript"` block starts from the outermost scope.
- **Tutorials**: one new thing per snippet, one heading per step (AGENTS.md
  "Tutorial Documentation Standard").
