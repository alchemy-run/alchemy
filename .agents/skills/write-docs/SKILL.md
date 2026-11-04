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
- `aws/networking/index.mdx`: containment as borders. `aws/compute/choosing-a-runtime.mdx`, `aws/messaging/sqs.mdx`, `aws/compute/lambda.mdx`, `cloudflare/compute/durable-objects.mdx`: diagrams built for their question.
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
7. **Design each diagram on purpose.** For every diagram, ask what a reader of
   that section would get wrong, pick the component that shows it (see
   [Diagrams](references/structure.md#diagrams)), and fill it with the page's
   own names and values. If no component fits, build one in
   `website/src/components/diagrams/` in the shared style, try it on its best
   page, and show the user before using it elsewhere.
8. **Build, look, push.** Run `pnpm run build` in `website/` (it regenerates
   llms and the reference). Put every new or changed diagram on one sheet with
   `scripts/diagram-sheet.py` and read it, screenshot whole pages with
   `scripts/screenshot.sh`, and check links with `scripts/check-links.sh`. Commit
   and push after each coherent change; don't batch a day's work. Docs-only PRs
   get a `docs(<scope>):` title. Add the `deploy-website` label for a preview at
   `pr-<N>-alchemy-website-preview.testing-2b2.workers.dev`.
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
- **Diagrams show the platform, not a request.** The What is diagram draws how
  the platform is structured and what contains what, as borders: an AWS account
  around a region, with IAM roles outside it; a Cloudflare account around a zone
  and a Durable Object namespace; a Neon project around its branches. A request
  flowing through boxes was rejected. Each platform has its own model, so draw
  that one. Use `groups` on `DAG`.
- **Pick the visual by the question.** A `DAG` was the only tool, and it was
  "so overused": a box-and-arrow picture of SQS, Lambda or KV showed nothing a
  reader didn't already know. Now there's a component per question: `Sequence`,
  `Timeline`, `WorldMap`, `Log`, `StateMachine`, `Records`, `BranchGraph`, `Tree`,
  `Responsibility`, and `DAG` for containment and real flows. The
  `Responsibility` chart for choosing a runtime was the one the user called
  great: it shows the idea itself, a staircase of who manages what.
  More: [Diagrams](references/structure.md#diagrams).
- **Don't reach for `Sequence` by default either.** After the DAG, Sequence
  became the overused one: 25 pages drew a request bouncing between lifelines.
  Use it only when the order of messages between parties *is* the idea (receive,
  hide, delete; a token exchange; an ACME challenge). Otherwise draw what the
  section is about: who can get past a boundary (`Boundaries`: Access,
  Turnstile, signed webhooks, private services, tunnels), what a log or table
  ends up holding (`Records`: a gateway's request log, the rows a pipeline
  keeps), what happens over time (`Timeline`: cache hits after a miss, webhook
  retries), or the states something moves through (`StateMachine`: a
  subscription). Count the Sequences across the docs after a batch; a dozen is
  plenty.
- **Box-and-arrow is the last resort.** A second review rejected eight more
  diagrams as "too generic": a bus with two rule boxes, a topic fanning out to
  three boxes, writer and reader arrows into a volume box, `t3.small → size →
  instance`, Deployment `creates` Pods, and a Web Function lane of scattered
  bars. Each became a picture of the thing itself: the event's JSON against each
  rule's pattern (`Fanout`), one line per subscriber, the queue's contents in no
  order and FIFO groups in line (`Queue`), zones under one shared volume
  (`Zones`), properties written inside the instance, objects on the API server
  above Pods on nodes (`Tree`), and the Lambda page's spike absorbed by one
  environment. Before drawing nodes and edges, ask what the thing looks like
  inside.
- **Draw movement and time, not tables.** Two components were built, rejected
  and deleted: `Phases` (a grid of sentences, half of them empty dashes) and
  `Matrix` (an allowed/denied truth table). Both said in boxes what a paragraph
  already said. Their pages now show a value travelling (`Sequence`), code
  running at two moments (`Timeline`), and a call passing two checks
  (`Sequence`). When the user rejects a kind of visual, remove the component
  and its rows in the skill, not just the one instance.
- **Containment is a border, never an arrow.** Whenever one thing holds another
  (an organization its accounts, a Bucket its objects, a cluster its instances,
  a namespace its objects, a role its policies), draw the holder as a border
  around what it holds. Arrows are only for things that move or call: requests,
  messages, writes, events. A tree of arrows fanning out from a parent was
  rejected as ugly and uninformative. Design each chapter's diagram for the one
  idea its section explains.
  More: [Diagrams](references/structure.md#diagrams).
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
- **Draw the platform's real model, in full.** An AWS organization drawn as four
  accounts in a box "left a lot to be desired": the real model is a tree of
  OUs, with policies flowing down. Then an org chart of connector lines was
  rejected too: draw it as nested borders, accounts inside their OU, OUs inside
  their parent, and the policy tag on the OU it's attached to. Before drawing, check what the platform
  actually supports (nesting, inheritance, scopes) and what the package can
  declare (`AWS.Organizations.OrganizationalUnit`, `Policy`), and show both.
- **Provider pages are about the provider.** Core Alchemy behaviour, like how
  `Config` travels from deploy to run time, `Redacted`, defaults, or reading
  Config in Construction rather than a handler, lives on the core pages
  (`/environments/secrets`, `/infrastructure-as-effects/phases`). A provider
  page says what's specific to its platform (Lambda encrypts environment
  variables and caps them at 4 KB; Worker `Config` binds as `secret_text`) and
  links the core page. Move anything worth keeping to the core page rather than
  deleting it.
- **Every concept chapter gets a diagram, on every provider.** AWS had one per
  chapter while GCP, Cloudflare and the smaller providers had almost none, and
  their docs read as "sparse". A chapter whose page jumps straight into code
  first gets a short section on the platform's model, then the diagram, then
  the code. Skip only tutorials and framework recipes. Before writing a
  diagram's labels, check each claim against the page and the source: a
  multi-node swarm, a resolve notification and a "more info needed" state
  were all drafted and cut because nothing backed them.
- **Show the snippet the section talks about.** A section that names a resource,
  like a CloudWatch dashboard, shows a small snippet declaring it.

## When you finish

Tell the user what changed per provider, what you verified (build, links,
screenshots), which claims you couldn't verify and so left out, and what you
deliberately didn't change and why. Offer the obvious next sweep when you found
one, like bun-first commands elsewhere in the docs.
