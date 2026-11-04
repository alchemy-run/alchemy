# Structure: sidebar, icons, llms, diagrams

## Sidebar

Each provider's sidebar is a block in `website/astro.config.ts`. Find it by its
hub-level `label: "<Provider>"` whose items start with
`{ label: "Overview", link: "/<provider>" }`. The GitHub label also appears
earlier in the header menu, so match on the Overview entry.

The order mirrors the platform:

1. Overview, What is X?, Setup, Local development (if any)
2. Tutorial
3. **Accounts & access**
4. Compute (on Cloudflare, split into Workers, Durable Objects, Workflows and Containers)
5. Storage & databases
6. Messaging & events
7. Networking & edge (or Networking)
8. Observability
9. Frontend, APIs, AI, Email, Guides

Rules:

- **Name a section by the reader's concern.** A section name must set its pages
  apart from the rest of the hub. No "Data" on a provider that is all data, and
  no "Concepts" catch-all when a real name exists.
- **No dangling pages.** Every page other than Overview, What is, Setup and Local
  development sits in a section.
- **Keep flat, stable URLs** (`/turso/tokens`). Moving a page between sections
  changes the sidebar, not its URL. Don't rename files to match sections.
- **Every new section label needs an icon** in `website/src/docs-icons.ts`
  `GROUP_ICONS`. It must be a real lucide name: `building`, not `building-2`.
- Check for orphans: pages that exist but are in no sidebar
  (`cloudflare/security/access.mdx` was one).

Moving items by hand is error-prone when an item spans several lines. Script
it: find the item by its `link:`, take its enclosing `{…},`, and reinsert it.
Then read `git diff astro.config.ts` before building.

## Other wiring

- `website/src/worker.ts` `REDIRECTS`: when a page moves to a new URL or is
  removed, map the old path to its closest new page.
- `website/src/docs-tabs.ts` and `website/src/components/ProviderDirectory.astro`:
  a new provider hub needs its header tab and its directory card.
- `providerResourcesEntry("<P>")` stays last in the provider's sidebar block.

## llms coverage

`website/scripts/generate-llms-txt.ts` has a `SECTIONS` list, and `build:llms`
fails when a published page is in no section, or in two. Add each new slug next
to its provider's existing slugs (e.g. after `"<provider>/what-is-<provider>"`).
`pnpm run build` regenerates `public/llms.txt`. Commit it.

## Diagrams

**Pick the visual by the question the section answers**, never by habit. A
`DAG` only answers "what connects to what". These docs ask more questions than
that, and each has its own component in `website/src/components/diagrams/`
(plus `DAG.astro`, `Responsibility.astro` and `HubMap.astro` in
`website/src/components/`). They share one look (`diagrams/diagram.css`), so
mixing them on a page is fine.

| The section answers | Component | Good example |
| --- | --- | --- |
| What holds what? What is the platform made of? | `DAG` with `groups` (borders) | `aws/what-is-aws`, `aws/networking` |
| What connects to what, and what flows where? | `DAG` (arrows) | `aws/messaging/sns`, `aws/frontend/websites` |
| Who manages each layer, you or the platform? | `Responsibility` | `aws/compute/choosing-a-runtime` |
| What happens, in what order, between whom? | `Sequence` | `aws/messaging/sqs`, `acme/what-is-acme` |
| What runs when? Concurrency, waiting, propagation | `Timeline` | `aws/compute/lambda`, `cloudflare/data/kv` |
| Where in the world does it run? | `WorldMap` | `cloudflare/compute/durable-objects`, `cloudflare/data/hyperdrive` |
| What is ordered, and who has read how far? | `Log` | `cloudflare/messaging/k2`, `aws/messaging/kinesis` |
| What states does it move through? | `StateMachine` | `cloudflare/messaging/queues`, `aws/observability/cloudwatch` |
| How is data laid out, and what does a query read? | `Records` | `aws/data/dynamodb`, `aws/data/s3` |
| When does each combination work? | `Matrix` | `aws/iam` (across accounts) |
| What does the same code do in each phase? | `Phases` | `aws/security/secrets-env`, `infrastructure-as-effects/phases` |
| How do copies relate over time? | `BranchGraph` | `neon/data/branching` |

Each component's JSDoc has its props and a usage example. Read it before using
one.

Rules for every diagram:

- **One idea per diagram**, the one its section explains. If the caption needs
  "and also", draw two, or cut one.
- **Show the behaviour, not the boxes.** A Lambda section is about one
  invocation per environment, so draw environments over time (`Timeline`), not
  a box called "environment". An SQS section is about receive, hide and delete,
  so draw the messages (`Sequence`). Ask what a reader would get wrong, and draw
  that.
- **Use real names and values** from the page's own example: `"user#sam"`,
  `getByName("lobby")`, `weur`, `maxRetries`, offsets, sizes, cities.
- **Containment is a border, never an arrow.** Arrows are only for things that
  move or call. Group ids and node ids must differ.
- **A diagram with no arrows and no meaningful borders is the wrong
  component.** Use a purpose-made one, or build a new one in
  `diagrams/` in the same style when no existing one answers the question.
- **Keep it compact.** Two or three columns read better than a row of five.
  Crop a `WorldMap` to the region that matters (`crop`), and set `center={180}`
  for a route across the Pacific.
- **Keep labels short**: about 16 characters for a box label and 20 for its
  type. A label that doesn't fit a short bar or edge belongs in a `legend` or
  the caption.
- **The caption says what the picture means**, in a sentence or two.
- **Look at it.** Run `scripts/diagram-sheet.py /tmp/sheet.png <path>…` against
  the dev server and read the sheet. Overlapping labels, overflowing text,
  missing edges and clipped bottoms don't show up any other way.

### DAG details

- **Auto layout** (`layer` on nodes) suits a left-to-right flow. **Grid layout**
  (`col` and `row` on every node) suits anything with borders or two dimensions.
- **Boundaries are `groups`**: `{ id, label, nodes, parent?, dashed? }`. Nest a
  region inside an account with `parent`, and draw the inner one `dashed`. An
  edge can point at a group's `id`, and it ends at the border.
- **Routing on the grid.** A straight edge runs along a row or a column. An
  elbow leaves the source's top or bottom and turns into the target's side; with
  `exit: "side"` it leaves the side and turns into the target's top or bottom.
- **An edge crossing two borders has no room for a label.** Drop the label and
  let the caption say it, or move the target a column further out.
- **`tone: "accent"`** marks the one node the diagram is about.

## Build

From `website/`:

```sh
pnpm exec astro build   # fast: pages only (~1300)
pnpm run build          # full: brand assets, API reference, llms, then astro
```

Run the full build before pushing a change that adds or moves pages. The dev
server (`pnpm exec astro dev`, http://localhost:4321) hot-reloads for
screenshots.
