---
name: alchemy-writing
description: Write Alchemy tutorials, pull requests, and releases.
---

# Alchemy Writing

## When to use

Load before writing tutorials, pull-request descriptions, release notes, or beta blog posts.

# Tutorial Documentation Standard

Tutorials under `website/src/content/docs/tutorial/` are **step-by-step and granular**: every code snippet introduces exactly **one** new thing, followed by a short prose explanation of just that thing. Each step gets its own `##` heading.

**Anti-pattern** — one snippet that adds multiple distinct changes, followed by a numbered list or bullet list explaining each:

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

**Correct** — split into one heading per step, each with one snippet and one explanation:

````md
## Bind the DO to the Worker

```diff lang="typescript"
+import Counter from "./counter.ts";

  Effect.gen(function* () {
+    const counters = yield* Counter;
    ...
  })
```

`yield* Counter` registers the DO with the Worker (binding + class-migration metadata) and hands you the namespace.

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

`counters.getByName(name)` returns a typed stub — `increment()` and `get()` round-trip through Cloudflare's RPC machinery.
````

Rules of thumb:

- If you find yourself writing "Two/three things just happened", "A few things are happening here", or a numbered/bulleted list explaining separate parts of a single snippet — **split the snippet**.
- One concept ⇒ one heading ⇒ one diff snippet ⇒ one explanation paragraph (no bullets).
- Bullet/numbered lists are fine when they describe a recap, prerequisites, or genuinely list-shaped content (e.g. "the Worker now handles two routes: PUT and GET" at the end). They are **not** fine as a substitute for splitting a compound snippet.
- A single API call that internally does several things (e.g. `Cloudflare.upgrade()`) doesn't need splitting — describe its behavior in prose.
- Use `diff lang="typescript"` blocks so each step shows what's added on top of the previous step.

# Pull Request Conventions

When you automatically open a PR, it MUST follow this structure:

- **Title**: Use conventional commit format (e.g. `fix(website): mobile theme metas`, `feat(aws/s3): add bucket lifecycle rules`).
- **Description heading levels**: NEVER use `#` or `##` in the PR description. The smallest heading allowed is `###`. The PR description must NOT begin with its own title heading — GitHub already renders the PR title above it.
- **Content**: Aim for the minimal content needed to convey the idea.
  - Use simple sentences. If there are multiple discrete changes, use bullet points.
  - **Prefer code snippets over prose.** A short ` ```ts ` or ` ```diff ` block showing the new/changed shape is worth more than a paragraph explaining it. Reach for code first; only add prose to fill in the "why" the snippet can't show on its own.
  - Be direct and succinct. Cut adjectives, justifications, and anything that reads like marketing copy. If a sentence is restating what the diff already shows, delete it.
  - **Never include a "Test plan", "Testing", or checklist of TODOs.** PR descriptions document the change, not the verification process. If something needs manual verification, follow the draft-PR rule below.
  - Skip examples for trivial fixes, internal refactors, or doc-only changes.

Example PR description (good — code snippet does the talking):

````
Track which state-store backend each project uses by emitting a `state_store.init` span tagged with `alchemy.state_store.kind`.

```ts
// every Layer.effect(State, …) site now wraps construction:
makeLocalState().pipe(recordStateStoreInit("local"))
```

Dashboard groups projects by kind from these spans (Axiom can't APL-query metric datasets).
````
- **Outstanding work / testing / review needed**: If there are outstanding steps, manual testing required, or review items, DO NOT leave a comment on the PR and DO NOT include them in the PR description. Instead:
  1. Mark the PR as **draft**.
  2. Tell the user (in the chat that initiated the PR creation) what is outstanding.

:::warning
**Markdown content must reach GitHub verbatim** — un-escaped backticks, fenced code blocks, etc. The reliable shape is to write the description to a file and pass `--body-file <path>` to `gh pr create` / `gh pr edit`:

```sh
# write the body to a temp file (use Write tool, not echo/cat heredoc)
gh pr edit 179 --body-file /tmp/pr-body.md
```

Do **not** inline the body via `--body "$(cat <<'EOF' ... EOF)"`. Even with a single-quoted heredoc some shells / `gh` versions still mangle backticks and backslashes; the resulting PR body ends up with literal `\`` sequences instead of inline code spans. `--body-file` sidesteps shell quoting entirely.

If you need to update an already-created PR's body, prefer `gh pr edit --body-file ...`. If that silently no-ops (older `gh` versions), fall back to `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@/tmp/pr-body.md`.
:::

The summary goes at the very top of the description as plain prose — NO heading above it, no `### Summary`, nothing. The PR title already serves as the title; do not repeat or re-title it. Only add `###` subheadings further down if the description genuinely has multiple sections worth separating.

Example PR description (good):

```
Persist the user's selected theme across reloads and fix a hero scroll glitch on mobile.

- Read theme from `localStorage` on mount before first paint
- Add `<meta name="theme-color">` per theme so mobile chrome matches
```

Example PR description (BAD — do not do this):

```
## Theme persistence fix    ← no, the PR title already exists
### Summary                  ← no, summary needs no heading
Persist the user's theme...
```

# Blog / Release Notes Conventions

Release blog posts live in `website/src/content/docs/blog/` named
`YYYY-MM-DD-beta-NN.md` (date = the release date).

**Frontmatter `title` format:** `<version> - <short title>`, e.g.
`2.0.0-beta.45 - Config & RPC Workers`. The title renders in the
blog TOC sidebar, so the descriptive suffix must be short — a few
words that fit neatly on one line. Lead with the version so the
list stays sorted and scannable.

Writing style (match the existing beta posts, e.g.
[beta.41](../../../website/src/content/docs/blog/2026-05-20-beta-41.md),
[beta.44](../../../website/src/content/docs/blog/2026-05-22-beta-44.md)):

- **Lean, concise, zero-fluff.** Illustrate each new
  feature/fix and link to the relevant docs/tutorials/guides.
- Read each PR in the release's changelog to understand what
  actually changed before writing.
- Lead with the headline features (one `##` heading each, with a
  short code snippet or `diff`), then fold the long tail into an
  `## Also in this release` bullet list.
- Put breaking changes in a `:::caution` callout at the top.
- Cite PRs inline as `([#NNN](https://github.com/alchemy-run/alchemy/pull/NNN))` and credit external
  contributors by name.
- End with a `## Where to go next` list of doc links plus the
  CHANGELOG and compare links.
