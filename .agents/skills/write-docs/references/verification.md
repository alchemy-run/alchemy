# Verification

Every API name, prop, environment variable and capability claim in the docs is
checked against the source before it ships. Most review corrections on provider
docs were confident claims that turned out wrong.

## Check snippets against the package

For each snippet, open the resource or binding it uses in
`packages/<provider>/src/` and confirm:

- **The export path and casing**: `AWS.ECS.Service(...)` is a function,
  not a class. `Cloudflare.ApiToken.AccountApiToken`, not `Cloudflare.AccountApiToken`.
- **Prop names**: `memorySize`, not `memory`. `migrations`, not `migrationsDir`.
  `path`, not `sourcePath`. `pointInTimeRecoveryEnabled`.
- **Prop types**: a `value?: string` prop takes `Config.String(...)`, not
  `Config.Redacted(...)`.
- **Attribute names**: `api.functionUrl`, `api.uri` on GCP, `ingest.token`.
- **The JSDoc examples** on the export. They are tested patterns. Prefer their
  shapes over inventing your own.
- **Required Layers**: a binding's client Layer is provided on the runtime
  (`Effect.provide(AWS.SQS.SendMessageHttp)`).
- **Resolved values**: an event source or consumer that needs a resolved
  resource yields it first (`const files = yield* Files`). A prop built from an
  output that isn't known until deploy uses `Output.map` (or
  `` Output.interpolate`…` ``).
- **Tested code first**: the `examples/<provider>-*` projects and the JSDoc
  examples. When a page needs code that no example has, add it to an example
  and deploy it first.
- **State the grant.** A binding section says which permission or role it
  grants, and that the grant covers only the bound resource.

## Check claims against the platform and the provider

- **Credentials and CI variables** come from the provider's `AuthProvider.ts` or
  `Contributions` module and its setup page, never memory.
- **Lifecycle behavior** comes from the provider's `delete`/`reconcile`. Destroying
  an `Axiom.ApiToken` revokes it; destroying a `GitHub.PersonalAccessToken`
  only forgets it. Read the code before writing either sentence.
- **Where a deploy lands** comes from the provider's `AuthProvider.ts`,
  `Credentials.ts` and environment code. Say what actually picks it: the
  profile's stored account ID (Cloudflare), the organization chosen at OAuth
  sign-in (PlanetScale), the token's workspace or else the first one
  (Railway), the token's organization unless a resource sets `orgSlug` (Fly).
  A region from a profile is a default that resources can override.
- **Runtime requirements** come from code: the Node minimum is in
  `packages/alchemy/bin/cli.js`.
- **Don't promise what Alchemy doesn't do.** Examples that were wrong:
  - "Alchemy backs up PlanetScale". It only restores from a `backupId`.
  - "D1 sessions" support, which is available only through the `raw` client.
  - "Server-side apply keeps an autoscaler's replicas". It overwrites them.
  - "Custom domains switch with no downtime".

  When the source doesn't support a claim, soften it to what's true, or cut it.
- **Platform facts** (city counts, feature availability) come from the
  platform's own current pages. Cite the source to the user. When you can't
  verify one, leave it out and say so.

## Check the built site

```sh
cd website && pnpm run build
.agents/skills/write-docs/scripts/check-links.sh website/src/content/docs/<provider>/<page>.mdx …
.agents/skills/write-docs/scripts/screenshot.sh /<provider>/<page>/ /tmp/<page>.png
.agents/skills/write-docs/scripts/diagram-sheet.py /tmp/sheet.png <provider>/<page> …
```

Read every diagram on the sheet from `scripts/diagram-sheet.py`.

## Bulk edits

Scripted sweeps across dozens of pages are the norm here, and three things
went wrong in this repo's docs:

- **Prose is hard-wrapped on some pages.** Deleting "to the end of the line"
  leaves half a sentence on the next one. Match the whole sentence across
  newlines, or edit those pages by hand.
- **Collapsing blank lines touches code blocks.** Python needs two blank lines
  between classes. Never normalize whitespace file-wide.
- **Imports sit between the frontmatter and the first paragraph.** A regex that
  cuts "everything before the first sentence" also cuts `import DAG …`.
- **Code samples contain `import` lines too.** Adding a component import after
  "the last `import` line" put it inside a TypeScript snippet on four pages, so
  the diagram silently didn't render. Insert imports only into the block right
  after the frontmatter, and compute the `../` depth from the docs root
  (`gcp/compute/x.mdx` needs `../../../../components/`).
- **A diagram that fails to render leaves no error on the page.** After adding
  diagrams, count them: the sheet prints how many it found, and 0 or fewer than
  you added means a broken import or a bad caption string.

After any sweep, read `git diff` for every line that isn't the change you meant,
and revert and hand-fix those files.

## Sweep for rejected phrasing

Before calling a change done, search all of `website/src/content/docs` (not just
the provider you touched) for phrasings already rejected:

```sh
grep -rnE "This page (introduces|covers|starts)|This chapter|rest of this page|set of services|A taste|default runtime|Bun or Node|Node\.js 22\+|SSO \(recommended\)" website/src/content/docs --include=*.mdx | grep -v /blog/
```

Fix each hit in pages you own. List the rest for the user rather than editing
unrelated pages unasked.

## Review diagrams one at a time

When the user reviews diagrams, show each one on its own, at the size the page
shows it, in page order, with one line on what it shows:

```sh
scripts/diagram-sheet.py --split /tmp/review aws/compute/choosing-a-runtime gcp/compute/choosing-a-runtime
```

Then embed the files in the reply. The two-per-row sheet is for your own
checking, because it shrinks every diagram and hides text that's too small.
When a review changes a diagram that another provider has a counterpart of,
change both.

## Long pages on a contact sheet

`diagram-sheet.py` captures the first 4000 CSS pixels of each page at 2x. A diagram further down comes out cut off or missing. Run it with `SHEET_SCALE=1` to capture 15000 pixels at 1x.
