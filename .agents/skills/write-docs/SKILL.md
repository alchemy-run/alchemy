---
name: write-docs
description: Write or rewrite the website docs for an Alchemy provider (AWS, Cloudflare, Fly, PlanetScale, any `@alchemy.run/*` package) at the house quality bar — a hub that says what the platform is, a "What is X?" page that teaches the platform's concepts once each, an "Accounts & access" section first, concept chapters structured like the platform, diagrams chosen for the question each section answers (sequences, timelines, maps, logs, state machines, record layouts, branch graphs, responsibility charts, borders for containment), small verified snippets, and a sidebar ordered by reader concern. Use for "write the docs for X", "rewrite the Fly docs", "bring the X docs up to par", "/write-docs neon", "add a What is X page", or any provider docs overhaul.
metadata:
  internal: true
---

# Write a provider's docs

A provider's docs teach the platform first and Alchemy second. A reader who has
never used Fly should leave the hub knowing what Fly is, leave "What is Fly?"
knowing its concepts and how they fit together, and find every concept page
built the same way: what the thing is on the platform, then how to use it from
an Alchemy Stack, in small snippets that compile.

The arguments name the providers (`fly`, `aws cloudflare`, …). You own the
pages, the sidebar, the build and the commits. Work in this checkout, one build
at a time. Docs live in `website/src/content/docs/<provider>/`. Never edit the
generated API reference under `website/src/content/docs/providers/`. That comes
from JSDoc (see AGENTS.md "Documentation Generation").

**Exemplars.** Read these before writing. They are the bar:

- `domain/what-is-ddd.mdx`: the original mental-model page. Copy its build-up
  of ideas, not its "This page introduces…" opening, which predates the rule.
- `aws/index.mdx`, `aws/what-is-aws.mdx`, `aws/accounts-and-regions.mdx`, `aws/iam.mdx`: hub, What is, and access chapters.
- Diagrams built for their question: `aws/accounts-and-regions.mdx` (OUs as nested borders), `aws/compute/choosing-a-runtime.mdx` (a responsibility staircase), `aws/messaging/sqs.mdx` (a queue's contents, then receive-hide-delete), `aws/compute/lambda.mdx` (environments over time), `cloudflare/networking/tunnel.mdx` (a tunnel through a wall), `cloudflare/compute/durable-objects.mdx` (a map).
- `cloudflare/accounts-and-tokens.mdx`, `fly/organizations-and-tokens.mdx`: short access pages.
- `aws/security/secrets-env.mdx`: a concept chapter that builds one idea at a time.

## The workflow

1. **Inventory.** List the provider's current pages, its sidebar block in
   `website/astro.config.ts`, and its package's resources and bindings
   (`ls packages/<provider>/src`, the `@resource`/`@binding` JSDoc). Note every
   page that's stale, package-centric, or missing.
2. **Map the platform.** Write down the platform's own concepts, in the order a
   newcomer meets them: account or organization, then access (tokens, IAM,
   roles), regions or locations, compute, storage and data, messaging, networking,
   observability. That order becomes the What is page and the sidebar.
3. **Propose framing before writing it.** Hub openings, page titles and the
   sidebar shape are judgment calls the user cares about. Post a short list of
   proposed intro statements, one per provider, plus the sidebar outline. Wait
   for feedback. Then apply it exactly, including the user's own phrasings.
   For a new convention (a page shape, a diagram style), draft it on one page
   on the dev server, show a screenshot, and roll it out to every provider only
   once the user likes it.
4. **Write the pages.** Write the hub, then What is, then the Accounts & access
   pages, then the concept chapters. Follow [page shapes](references/page-shapes.md)
   and [voice](references/voice.md).
5. **Verify every claim and snippet against the source.** See
   [verification](references/verification.md). A wrong prop name or an
   overstated capability is worse than a missing paragraph.
6. **Wire up structure.** Register sidebar entries, icons and llms coverage. See
   [structure](references/structure.md).
7. **Design each diagram on purpose.** Follow [Diagrams](#diagrams): ask what a
   reader of that section would get wrong, pick the component that shows it
   (see [the component table](references/structure.md#diagrams)), and fill it
   with the page's own names and values. If no component fits, build one in
   `website/src/components/diagrams/` in the shared style, try it on its best
   page, and show the user before using it elsewhere.
8. **Build, look, push.** Run `pnpm run build` in `website/` (it regenerates
   llms and the reference). Check every changed Tree with
   `scripts/tree-check.mjs` at both widths, put every new or changed diagram
   on one sheet with `scripts/diagram-sheet.py` and read it, screenshot whole pages with
   `scripts/screenshot.sh`, and check links with `scripts/check-links.sh`. Commit
   and push after each coherent change; don't batch a day's work. Docs-only PRs
   get a `docs(<scope>):` title. Add the `deploy-website` label for a preview at
   `pr-<N>-alchemy-website-preview.testing-2b2.workers.dev`. When the scope
   grows, rewrite the PR body to match and read it back with
   `gh api repos/<owner>/<repo>/pulls/<n>`. `gh pr edit --body-file` can exit
   cleanly and change nothing, so fall back to `gh api -X PATCH … -F body=@file`.
9. **Iterate on feedback in the same PR.** Apply feedback everywhere it applies,
   not just on the page the user pointed at. When they flag one hub, fix every hub.
   Then grep the whole docs tree for the rejected phrasing (see
   [verification](references/verification.md#sweep-for-rejected-phrasing)), and
   add the rule below so it isn't relearned.

## Rules that came from review

Each of these was a correction. Don't relearn them.

- **The hub says what the platform is**, at a high level and technically:
  "Fly.io runs your apps as fast-booting virtual machines…". Never "the package
  puts X in one typed program".
- **The hub and What is never overlap.** The hub is intro, quick example, where to
  start, and the `<HubMap />` docs map, with no diagram. What is explains and
  draws the platform. A hub diagram that repeated What is was rejected. Keep
  pages that follow each other from repeating each other, but never by writing
  about the page ("This page introduces…"): that was rejected harder than the
  repetition.
  More: [Hub](references/page-shapes.md#hub).
- **Technical documentation, not news.** No ownership, acquisitions, user or
  customer counts, service or region counts, founding history, or lines like
  "from a weekend project to a bank". Keep a number only when it changes how the
  platform behaves for the reader, like Cloudflare's 340+ cities for latency.
  The same goes for superlatives: "the largest public cloud" says nothing about
  AWS a reader can use. Keep one only when it's the platform's defining trait
  and the user asked for it (Cloudflare's network, PlanetScale's speed).
- **Say plainly what the platform is**: "a cloud platform with services for
  compute, storage, …". Never "a set of services", "a cloud of a few hundred
  services" or "a collection of services"; those were rejected, twice. Then say
  what it's known for, not a short list of the services we happen to support.
- **No bias the product doesn't have.** Don't call one runtime "our default".
  Recommend an option for a stated reason ("an easy, cheap place to start") and
  present the alternatives fairly.
- **Recommend what suits most readers first.** AWS console login (keyless, works
  for every account) comes before SSO (for organizations that set up IAM Identity
  Center). Call out who each option is for.
- **Node.js first, linked, then Bun.** Write "[Node.js](https://nodejs.org) 24.11.1+ or [Bun](https://bun.sh)",
  using the minimum from `packages/alchemy/bin/cli.js`.
- **Commands are package-manager neutral, pnpm first.** Every install or
  `alchemy` command is `<PackageManagers>` tabs (pnpm, bun, npm, yarn), never a
  raw ```sh block with one manager hard-coded, `bun alchemy` or `npx alchemy`
  alike. `add`/`dev`/`run` cover single commands. A block that mixes in `curl`,
  `git`, prompts or comments is `script={`…`}`, with `{run}` for an installed
  binary (`pnpm`, `bun`, `npx`, `yarn`) and `{dlx}` for a remote package like
  `auth@1.7.5` or `create-*` (`pnpx`, `bunx`, `npx`, `yarn dlx`). Prose writes
  the CLI bare: `alchemy deploy`. Bun-only commands (`bun test`, `bun build`)
  stay as written inside the tabs, and GitHub Actions workflows that set up Bun
  themselves stay as they are. Two sweeps were needed: first for bun-first
  blocks, then for the `npx` the first sweep hard-coded in their place.
- **Accounts & access comes first**, right after the tutorial, on every provider.
  More: [Accounts & access](references/page-shapes.md#accounts--access).
- **Every secrets page mentions secret providers** (Doppler, Infisical, per-stage
  `secrets`), not just `.env`.
  More: [Secrets pages](references/page-shapes.md#secrets-pages).
- **Never write about the page itself.** No "This page introduces…", "This
  chapter starts with…, then…", "the rest of this page explains…". Open on the
  subject, and introduce an example as "Take one small app: …". A short repeat
  of the hub's introduction is better than a sentence about the page.
- **Say precisely where a deploy goes.** A profile signs in to an account and
  sets a *default* region; it doesn't sign in to a region. Whether the account,
  organization or workspace comes from the profile, the token, or a resource
  prop (`orgSlug`, `workspaceId`) differs per provider, so read its
  `AuthProvider.ts` and environment code before writing the sentence.
  More: [Verification](references/verification.md#check-claims-against-the-platform-and-the-provider).
- **Words the user rejected**: "A taste" (now "A quick example"), "a set of
  services", "the largest" when it isn't the point, "New to X? … walks through
  a, b, c, d, e…" (now "Start with [What is X?]").
- **Provider pages are about the provider.** Core Alchemy behaviour, like how
  `Config` travels from deploy to run time, `Redacted`, defaults, or reading
  Config in Construction rather than a handler, lives on the core pages
  (`/environments/secrets`, `/infrastructure-as-effects/phases`). A provider
  page says what's specific to its platform (Lambda encrypts environment
  variables and caps them at 4 KB; Worker `Config` binds as `secret_text`) and
  links the core page. Move anything worth keeping to the core page rather than
  deleting it.
- **Example names read as placeholders.** Name example resources so nobody
  mistakes them for a platform feature or a concept they must learn:
  `MyEnv`, `MyTemplate`, `MyImage`, `MySandbox`, `acme`, `user-42`. An
  `Agents` environment and an `Agent` template were rejected because
  "Agents" reads like something the platform has. Keep a product's real
  names (Cloudflare Agents, Boat's Agents page) and words that describe the
  use ("agent loops"), and rename the diagram, prose, code and example
  together so they still match.
- **Show the snippet the section talks about.** A section that names a resource,
  like a CloudWatch dashboard, shows a small snippet declaring it.

## Diagrams

Diagrams were reviewed harder than anything else in these docs. Every rule here
replaced a diagram the user rejected. Details, the component table and layout
gotchas are in [Diagrams](references/structure.md#diagrams).

- **Every concept chapter gets one, on every provider.** GCP, Cloudflare and the
  smaller providers once had almost none, and read as "sparse" next to AWS. A
  chapter that starts straight with code first gets a short section on the
  platform's model, then the diagram, then the code. Skip tutorials and
  framework recipes, and pages about a way of writing code rather than a
  platform: "How SQL works in Alchemy" had a timeline of a deploy and three
  request connections, and it was cut with "we don't need a diagram for sql".
- **Draw the thing, not a request bouncing between boxes.** Ask what the
  section is about and what a reader would get wrong, then draw that: the
  queue's contents, the event's JSON against each rule, an environment over
  time, a tunnel through a wall. Generic pictures were rejected again and
  again: a request flowing through boxes, `t3.small → size → instance`, a topic
  fanning out to three boxes, writer and reader arrows into a volume box,
  Deployment `creates` Pods.
- **Pick the component by the question**, never by habit. `DAG` and then
  `Sequence` each became "so overused". Use `Sequence` only when the order of
  messages between parties is itself the idea (receive, hide, delete; a token
  exchange). About a dozen across the docs is plenty, so count them after a
  batch. **Never put a `Sequence` on a What is page**: it draws the platform's
  pieces and where they live, not a run through them. ACME's challenge flow
  became a `Boundaries` figure: your deploy, the authority and your zone, with
  the authority checking the TXT record in a zone only you can write to.
- **Don't make everything a `Shell`.** Nested boxes say "runs inside". A git
  host's Layers inside a Worker are nested. An ACME account inside its
  authority, and a certificate inside its order, were rejected: "this makes
  no sense". The best-received diagrams showed the idea itself:
  `Responsibility`'s staircase of who manages what, OUs as nested borders, and
  the Tunnel as an arrow through a dotted gap in the wall.
- **Containment is a border, never an arrow.** An organization around its OUs
  and accounts, a Bucket around its objects, a branch around its database. An
  arrow is only for something that moves or calls. Never write containment into a
  label either ("subnet in your VPC"): draw every layer, and don't drop
  layers to make a smaller copy of a diagram the chapter already draws.
- **Connections are arrows, not text.** Draw what holds what as borders and
  what calls what as `links` on a `Tree`, each with a short verb ("binds",
  "mounts", "runs as"). Writing "binds Uploads · Rooms · Jobs" inside a box
  was rejected as no thought given to how the boxes connect.
  More: [Tree: borders and arrows](references/structure.md#tree-borders-and-arrows).
- **Every node connects to the story, or goes.** A box with no arrow and no
  role in the caption is noise: Boat's `DevBox` sat under the app relating to
  nothing ("no idea how DevBox relates to anything"), and E2B's and Modal's
  secrets floated unconnected. Connect each secret, volume and image to what
  uses it, or cut it and let the section that covers it draw it.
- **A box holds only what really runs or lives in it.** Before nesting, check
  the source for where each thing runs. Rivet's pools were drawn inside the
  control plane, but nodes run on their own clouds and connect out to it; a
  namespace is a grouping of pools, so it became a dashed border around them,
  outside the control plane. Don't invent a container either: Effect Cluster
  has no "control plane", so its Api (your app) sits outside a border around
  the pool and its database.
- **Name what each box is, and label arrows with the action.** A box the
  reader can't place gets asked about ("is it my Api or Effect Cluster's?"):
  type a caller `your app`. An arrow label is a verb (`calls lobby`, `routes`,
  `creates`), never the destination's name. "gateway" on an arrow made the
  gateway read as part of the caller, so draw the destination as its own box.
- **Show who creates run-time objects, and how many.** Sandboxes, volumes and
  sessions an app creates while it runs need their creator drawn (your Worker,
  with an arrow labelled `creates one per person`), and two instances when the
  count is the point (`session-sam`, `session-ana` booting from one image).
  "Volume · one per user" was rejected: it read as one shared volume, and "user"
  was ambiguous (the platform's account holder, or a person using the app?).
- **Parallel inputs sit side by side.** A snapshot (the disk) and an
  environment (the secrets) both feed a sandbox, so put them in one row above
  it, each arrow labelled with what it supplies (`disk`, `secrets`). Stacked one
  above the other, the environment looked like a step between the snapshot and
  the sandbox ("I don't understand why environment is where it is").
- **Answer structural questions from the source before drawing.** Does a
  project sit in an organization? Is there a region? Is the organization a
  container or a billing target? Grep the platform's SDK and docs, then draw
  what's true: a GCP project inside its organization; Boat with no region and
  an account that "can bill an organization instead". Say in the caption what a
  reader might expect but won't find.
- **No wasted space.** A full-width bar for one small box, a column of empty
  space beside a stacked layout, and a container mostly empty around one box
  were each called out. Try the caller beside what it calls (an arrow straight
  across) and the runtime's pieces side by side before settling on a tall stack.
- **Every diagram works on a phone and a desktop, flush.** Lay boxes out with
  `areas` and `phoneAreas` so arrows run short and straight at both widths,
  then run `scripts/tree-check.mjs` and read its screenshots before showing
  anyone. Ragged rows, stretched or empty boxes, labels on lines and
  arrowheads on tiny stubs were each caught by the user first, which is what
  the checker is for.
- **The same thing gets the same icon on every page.** Postgres is always
  `brand:postgresql`, whether it's a container, a managed database or a branch's
  compute. An Api that is a service, app or container is always `server`; one
  that is a Worker or Function is `square-function`. Images (`package`) and
  volumes (`hard-drive`) keep their kind's icon. Before picking an icon, grep
  the other diagrams for the same thing and reuse theirs. The Docker diagram
  drew Postgres and Api with generic container icons and was flagged.
- **A property is not a node.** An instance's type and image, or a Worker's
  tokens, go inside its box (`specs`), not in boxes of their own with arrows.
- **Draw the platform's real model, in full.** An AWS organization is a tree of
  OUs with policies flowing down, not four accounts in a box. GCP's VPC is
  global and its subnets are regional. An edge goes to what it really targets: a Worker binds
  a Durable Object *namespace*, so the binding arrow ends on the namespace's
  border (a DAG edge can target a group id), never on one object inside it.
- **Never a table of text in boxes.** `Phases` (a grid of sentences) and `Matrix`
  (an allowed/denied truth table) were built, rejected and deleted. When a kind
  of visual is rejected, delete the component and its rows here, not just the
  one instance.
- **Fill it with the page's own names and values**, and check every label against
  the page and the source. A multi-node swarm, an Axiom "resolved" alert and a
  Stripe "more info needed" state were drafted and cut, because nothing backed
  them.
- **The same kind of page looks the same on every provider.** When one
  provider gets a better diagram for a page every provider has (choosing a
  runtime, accounts and access, secrets), give it to the others in the same
  change. More: [Choosing a runtime](references/page-shapes.md#choosing-a-runtime).
- **It must read at the column's width.** Lay wide things out top to bottom, keep
  labels short, put no label on top of a line, and leave no empty rows or
  right-hand space. Look at every diagram on a contact sheet and on the real
  page before you push.

## When you finish

Before you show the user anything:

- Run `scripts/tree-check.mjs` on every changed page (or `--all` after a
  component change), and read both widths' screenshots. A diagram that comes
  back from review is a check you didn't run: add it to the checker, prove it
  fires on the bad version, then fix the diagram.
- `.claude/skills/<name>` holds symlinks into `.agents/skills/<name>`. Stage
  skill edits from `.agents/skills/…`: `git add .claude/skills/…` stages
  nothing, and a skill update was reported as pushed when it never was.
  Confirm with `git show --stat HEAD` before saying it's pushed.

Tell the user what changed per provider, what you verified (build, links,
screenshots), and show each new or changed diagram on its own (`diagram-sheet.py
--split`, see [verification](references/verification.md#review-diagrams-one-at-a-time)).
Say which claims you couldn't verify and so left out, and what you
deliberately didn't change and why. Offer the obvious next sweep when you found
one, like bun-first commands elsewhere in the docs.
