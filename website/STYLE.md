# Alchemy docs style guide

This guide covers every hand-written page under `website/src/content/docs`.
Read it before you write or edit a docs page, and give it to any agent
that edits docs.

The generated API reference under `website/src/content/docs/providers/`
comes from JSDoc in `packages/alchemy/src`. The sentence rules below
apply to that JSDoc too. Its layout rules live in the "Documentation
Generation" section of [AGENTS.md](../AGENTS.md).

The guide draws on three established sources:

- [Diátaxis](https://diataxis.fr) for page types and structure.
- The [Google developer documentation style guide](https://developers.google.com/style)
  for sentences, words, and formatting. Follow it where this guide is
  silent.
- The [Federal Plain Language Guidelines](https://www.plainlanguage.gov/guidelines/)
  for clarity.

The Alchemy rules in section 5 are stricter than those sources. When
they conflict, this guide wins.

## 1. Pick one page type

Every page serves one of four needs. Decide which one before you write,
and declare it in the frontmatter with `type`.

| `type` | The reader wants to | Examples |
| --- | --- | --- |
| `tutorial` | learn by building something | Getting started, `cloudflare/tutorial/*` |
| `how-to` | get a specific task done | CI, Testing a Stack, Custom Provider |
| `reference` | look up an exact fact | generated `/providers` pages, CLI commands |
| `explanation` | understand how and why it works | What is Alchemy?, Phases, Resource lifecycle |

```yaml
---
title: Phases
description: When your code runs at deploy time and when it runs in the deployed runtime.
type: explanation
---
```

A page that tries to be two types serves neither reader well. The
usual signs are an option table in a tutorial, a "how it works inside"
section in a how-to guide, or numbered steps in an explanation. Fix it
by moving the extra material to a page of the right type and linking
to it.

### Tutorials

- Follow one path that always works. Leave out alternatives and options.
- Make every step leave the project in a working state.
- Explain only what the reader needs for the next step. Link to
  explanations for the rest.
- End by saying what the reader built and where to go next.
- Change one thing per step. See [Tutorial steps](#6-tutorial-steps).

### How-to guides

- Name the page after the task ("Deploy from CI", "Test a provider").
- Open with the goal and any prerequisites.
- Give the steps in the order the reader runs them.
- Show one way to do it. Mention an alternative in one sentence with a
  link.
- Assume the reader knows the concepts. Link to the explanation page
  instead of repeating it.

### Reference

- Be complete and exact. Every option, default, and error the reader
  might look up.
- Follow the shape of the code. One entry per option, in a consistent
  format.
- Leave out teaching and narrative.
- Prefer generated reference (JSDoc) over hand-written tables. A
  hand-written page links to the generated reference instead of copying
  its options.

### Explanations

- Describe how something works and why it was designed that way.
- Use diagrams and short examples to support the explanation.
- Leave out step-by-step instructions. Link to the how-to guide.

## 2. Structure a page

- **Open with what and when.** The first two or three sentences say
  what the page covers and when the reader needs it.
- **Start simple.** Show the simplest working case first and build up
  to advanced cases. A reader who stops early still has something
  correct.
- **Give each concept one home.** Explain a concept fully on one page.
  Other pages summarize it in one sentence and link there.
- **Make every page stand alone.** Readers arrive from search. Define a
  term or link to its page the first time you use it.
- **Use descriptive headings.** Write them in sentence case. Name the
  task or the topic ("Retry the first request", "Physical names").
  Don't skip heading levels.
- **Keep heading text stable.** Headings are link anchors. If you
  rename one, search `website/src/content` for links to the old anchor
  and update them.
- **End with "Where next".** A short list of links in the form
  `- [Page](/path): what the reader finds there`.
- **Prefer shorter.** Every section should answer a question this
  page's reader has. Detail for a different reader goes on that
  reader's page.

## 3. Write sentences

- **Lead with the point.** Put the fact or instruction first and the
  reason second.
- **One idea per sentence.** Split a sentence that carries two facts.
- **Use active voice, present tense, and "you".** Write "Alchemy
  creates the Bucket". Avoid "The Bucket will be created".
- **Put the condition before the instruction.** Write "To deploy a
  stage, run `alchemy deploy --stage prod`".
- **Say what things are and do.** State facts directly. Contrast
  something with an alternative only when the reader needs that
  distinction.
- **Use plain words.** Write use, run, create, returns, lets you. Avoid
  leverage, utilize, facilitate, empower, and ensure (when "make sure"
  or a direct verb works).
- **Write descriptive link text.** Write "see [Profiles](/environments/profiles)".
  Avoid "click here" and bare URLs.

**Before**

> That's it — you have a live R2 Bucket on Cloudflare. Full command
> reference: [CLI](/cli).

**After**

> You now have a live R2 Bucket on Cloudflare. See [CLI](/cli) for the
> full command reference.

## 4. Use the same words

Use one term for one concept, every time. Write concept names in
lowercase in prose. Use code formatting for the TypeScript symbol.

- **stack**: the unit you deploy. The symbol is `Alchemy.Stack`.
- **stage**: one deployed copy of a stack, such as `prod` or `pr-42`.
- **resource**: a cloud entity the stack manages.
- **provider**: the code that creates, updates, and deletes one
  resource type.
- **runtime**: a resource that runs your code, such as a Worker or a
  Lambda Function.
- **binding**: what gives a runtime access to a resource.
- **layer**: an Effect `Layer`. Capitalize it only as `Layer` in code
  formatting.
- **state store**: where Alchemy records what it deployed.
- **logical ID** and **physical name**: the ID in your code and the
  name in the cloud.

Capitalize product and resource-type names the way the vendor does:
Worker, Durable Object, R2 Bucket, Lambda Function, DynamoDB Table.

## 5. Alchemy house rules

These rules are stricter than the Google guide. The Vale `Alchemy`
style checks most of them.

### Colons

Use a colon only at the end of a sentence that introduces a code block,
list, or table, and in list items shaped `- **Term**: description` or
`- [Link](/path): description`. Never use a colon to join two clauses.
Write the relationship in words ("because", "so", "for example") or
split the sentence.

**Before**

> `Alchemy.localState()` does not work here: it writes state to
> `.alchemy/state` in the directory you run `alchemy` from.

**After**

> `Alchemy.localState()` does not work here because it writes state to
> `.alchemy/state` in the directory you run `alchemy` from.

### Dashes and other punctuation

- Avoid em dashes. Use at most one per paragraph, and only when no
  plain sentence reads better. Replacing a dash with a colon does not
  fix it.
- Avoid semicolons. Split the sentence.
- Keep parentheses for short asides. Never nest them.
- Never use exclamation marks.
- Use bold only for a term you define or a list-item label. Don't use
  it for emphasis.

**Before**

> Resources stay running across reloads — only your application code
> restarts.

**After**

> Resources stay running across reloads. Only your application code
> restarts.

### No marketing language

Alchemy is a technical product. Delete words that add tone without
adding a fact, such as powerful, seamless, simply, just, easily, effortless,
robust, blazing, magic, elegant, beautiful, first-class, incredibly,
truly, out of the box. Keep a word only when it states a fact ("the
fast path skips the schema decode").

### No contrast framing

Remove "it's not X, it's Y", "X, not Y", "this isn't about X", and "no
X, no Y, just Z" when the contrast exists only for effect. State what
the thing is or does.

**Before**

> Code changes take effect in **milliseconds**, not minutes.

**After**

> Code changes take effect in milliseconds.

### No chatty narration

Remove "Let's", "Here's the thing", "Notice that", "It's worth noting",
"Under the hood", "That's it", "The key insight", "In other words",
rhetorical questions, and triplets written for rhythm.

### Bun and Node are equal

Present Bun and Node.js as equal options. Write "[Bun](https://bun.sh)
or Node.js 22.15+" with no "(recommended)" label.

## 6. Tutorial steps

Tutorials change one thing per step. Each step gets its own `##`
heading, one `diff lang="typescript"` snippet, and one short paragraph
that explains that one change.

If you find yourself writing "Two things just happened" or a list that
explains separate parts of one snippet, split the snippet.

**Before**

````md
## Bind the DO to the Worker

```diff lang="typescript"
+import Counter from "./counter.ts";
+import { HttpServerRequest } from "...";

  Effect.gen(function* () {
+    const counters = yield* Counter;
    return {
      fetch: Effect.gen(function* () {
+        const request = yield* HttpServerRequest;
+        if (request.url.startsWith("/counter/") && ...) {
+          const next = yield* counters.getByName(name).increment();
+          return HttpServerResponse.text(String(next));
+        }
        return HttpServerResponse.text("Hello!");
      }),
    };
  })
```

Two things just happened:
1. `yield* Counter` registers the DO ...
2. `counters.getByName(name)` returns a typed stub ...
````

**After**

````md
## Bind the DO to the Worker

```diff lang="typescript"
+import Counter from "./counter.ts";

  Effect.gen(function* () {
+    const counters = yield* Counter;
    ...
  })
```

`yield* Counter` registers the DO with the Worker and returns the
namespace.

## Call the DO from `fetch`

```diff lang="typescript"
+import { HttpServerRequest } from "...";

  fetch: Effect.gen(function* () {
+    const request = yield* HttpServerRequest;
+    if (request.url.startsWith("/counter/") && ...) {
+      const next = yield* counters.getByName(name).increment();
+      return HttpServerResponse.text(String(next));
+    }
    return HttpServerResponse.text("Hello!");
  })
```

`counters.getByName(name)` returns a typed stub. `increment()` and
`get()` run on the Durable Object through Cloudflare RPC.
````

- A single API call that does several things internally, such as
  `Cloudflare.upgrade()`, needs no split. Describe its behavior in
  prose.
- Lists are fine for a recap, prerequisites, or content that is a list.

## 7. Code examples

- **Use real APIs.** Every identifier, option, import path, and default
  must exist in `packages/alchemy/src`. Check the source before you
  write it.
- **Introduce each block.** One sentence before the block says what it
  does. After the block, explain only what the code doesn't show.
- **Make examples copyable.** Show imports the first time a symbol
  appears. Mark omitted code with `// ...`.
- **Use package-manager tabs** for commands the reader runs
  (`<Tabs syncKey="pkgManager">`).
- **Never include real secrets.** Use placeholders such as
  `<your-api-token>`.

## 8. Check your work

Run the prose linter from `website/`:

```sh
brew install vale   # once
pnpm docs:lint
```

`pnpm docs:lint` runs [Vale](https://vale.sh) with the Google style and
the `Alchemy` style in `website/.vale/styles/Alchemy`. It skips the
generated `/providers` pages and the blog.

Before you open a PR, also check:

- The page has one `type`, and every section serves that type.
- Each concept you explain has no other full explanation elsewhere.
- Every code example uses real APIs.
- Renamed headings have no broken inbound links.
