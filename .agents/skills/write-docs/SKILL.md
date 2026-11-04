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
   llms and the reference). Put every new or changed diagram on one sheet with
   `scripts/diagram-sheet.py` and read it, screenshot whole pages with
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
  framework recipes.
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
  exchange; an ACME challenge). About a dozen across the docs is plenty, so
  count them after a batch. The best-received diagrams showed the idea itself:
  `Responsibility`'s staircase of who manages what, OUs as nested borders, and
  the Tunnel as an arrow through a dotted gap in the wall.
- **Containment is a border, never an arrow.** An organization around its OUs
  and accounts, a Bucket around its objects, a branch around its database. An
  arrow is only for something that moves or calls. Never write containment into a
  label either ("subnet in your VPC"): draw every layer, and don't drop
  layers to make a smaller copy of a diagram the chapter already draws.
- **A property is not a node.** An instance's type and image, or a Worker's
  tokens, go inside its box (`specs`), not in boxes of their own with arrows.
- **Draw the platform's real model, in full.** An AWS organization is a tree of
  OUs with policies flowing down, not four accounts in a box. GCP's VPC is
  global and its subnets are regional.
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

Tell the user what changed per provider, what you verified (build, links,
screenshots), and show each new or changed diagram on its own (`diagram-sheet.py
--split`, see [verification](references/verification.md#review-diagrams-one-at-a-time)).
Say which claims you couldn't verify and so left out, and what you
deliberately didn't change and why. Offer the obvious next sweep when you found
one, like bun-first commands elsewhere in the docs.
