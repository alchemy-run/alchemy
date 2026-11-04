---
name: write-docs
description: Write or rewrite the website docs for an Alchemy provider (AWS, Cloudflare, Fly, PlanetScale, any `@alchemy.run/*` package) at the house quality bar — a hub that says what the platform is, a "What is X?" page that teaches the platform's concepts once each, an "Accounts & access" section first, concept chapters structured like the platform, DAG diagrams, small verified snippets, and a sidebar ordered by reader concern. Use for "write the docs for X", "rewrite the Fly docs", "bring the X docs up to par", "/write-docs neon", "add a What is X page", or any provider docs overhaul.
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

- `domain/what-is-ddd.mdx`: the original mental-model page.
- `aws/index.mdx`, `aws/what-is-aws.mdx`, `aws/accounts-and-regions.mdx`, `aws/iam.mdx`: hub, What is, and access chapters.
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
4. **Write the pages.** Write the hub, then What is, then the Accounts & access
   pages, then the concept chapters. Follow [page shapes](references/page-shapes.md)
   and [voice](references/voice.md).
5. **Verify every claim and snippet against the source.** See
   [verification](references/verification.md). A wrong prop name or an
   overstated capability is worse than a missing paragraph.
6. **Wire up structure.** Register sidebar entries, icons and llms coverage. See
   [structure](references/structure.md).
7. **Build, look, push.** Run `pnpm run build` in `website/` (it regenerates
   llms and the reference). Screenshot any page with a new diagram
   (`scripts/screenshot.sh`) and check links (`scripts/check-links.sh`). Commit
   and push after each coherent change; don't batch a day's work. Docs-only PRs
   get a `docs(<scope>):` title. Add the `deploy-website` label for a preview at
   `pr-<N>-alchemy-website-preview.testing-2b2.workers.dev`.
8. **Iterate on feedback in the same PR.** Apply feedback everywhere it applies,
   not just on the page the user pointed at. When they flag one hub, fix every hub.

## Rules that came from review

Each of these was a correction. Don't relearn them.

- **The hub says what the platform is**, at a high level and technically:
  "Fly.io runs your apps as fast-booting virtual machines…". Never "the package
  puts X in one typed program".
- **The hub and What is never overlap.** The hub is intro, taste, where to
  start, and the `<HubMap />` docs map, with no diagram. What is explains and
  draws the platform. A hub diagram that repeated What is was rejected.
  More: [Hub](references/page-shapes.md#hub).
- **Technical documentation, not news.** No ownership, acquisitions, user or
  customer counts, service or region counts, founding history, or lines like
  "from a weekend project to a bank". Keep a number only when it changes how the
  platform behaves for the reader, like Cloudflare's 340+ cities for latency.
- **Say what the platform is known for**, not a short list of the services we
  happen to support ("Google Cloud is a set of services for running code" was
  rejected as too small).
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
  More: [Diagrams](references/structure.md#diagrams).
- **Show the snippet the section talks about.** A section that names a resource,
  like a CloudWatch dashboard, shows a small snippet declaring it.

## When you finish

Tell the user what changed per provider, what you verified (build, links,
screenshots), which claims you couldn't verify and so left out, and what you
deliberately didn't change and why. Offer the obvious next sweep when you found
one, like bun-first commands elsewhere in the docs.
