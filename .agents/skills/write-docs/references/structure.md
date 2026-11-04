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

Use `website/src/components/DAG.astro`. Hubs have no diagram; their docs map is
`website/src/components/HubMap.astro`, drawn from the sidebar. Never embed images or ASCII art. A
What is page's diagram shows the platform's structure (see SKILL.md), drawn
with `groups` on the grid.

- **Not every idea is a graph.** Pick the visual for what the section explains.
  A spectrum of who manages what (choosing a runtime) is
  `website/src/components/Responsibility.astro`: runtimes as columns, layers as
  rows, the cells you manage filled. A group of boxes with no edges says
  nothing; when a `DAG` would have no arrows and no meaningful borders, it's
  the wrong component. Build a small purpose-made one instead.
- **Auto layout** (`layer` on nodes) suits a left-to-right flow. **Grid layout**
  (`col` and `row` on every node) suits anything with borders or two dimensions.
- **Boundaries are `groups`**: `{ id, label, nodes, parent?, dashed? }`. Nest a
  region inside an account with `parent`, and draw the inner one `dashed`. An
  edge can point at a group's `id`, and it ends at the border (`profile` →
  `account`, labelled "deploy"). Leave a free row or column where a border needs
  room.
- **Borders for containment, arrows for flow.** Never draw "A contains B" as an
  arrow from A to B. Group ids and node ids must differ.
- **Keep it compact.** Two or three columns read better than a row of five,
  which shrinks to fit the column. Wrap a long sequence into two rows. A small
  diagram stays at its natural size rather than stretching to the column.
- **Routing on the grid.** A straight edge runs along a row or a column. An
  elbow leaves the source's top or bottom and turns into the target's side; with
  `exit: "side"` it leaves the side and turns into the target's top or bottom.
  Pick whichever keeps lines off other nodes and from sharing a segment. An edge
  to a group from above or below runs vertically into its border.
- **Group borders size themselves** to their label, and a label moves clear of
  an edge running through it. Keep node labels to about 16 characters and types
  to about 20 (`postgres:18`, not `postgres:18-alpine`), or they overflow the
  node. A one-node group needs a short label (`weur`, not `Western Europe`) when
  an edge crosses its top.
- **An edge crossing two borders has no room for a label.** Drop the label and
  let the caption say it, or move the target a column further out.
- **Edge labels are platform terms** (`s3:PutObject`, `runs as`, `flycast`).
  Labels on vertical edges sit beside the line.
- **`tone: "accent"`** marks the one node the diagram is about.
- **The caption says what the picture means**, in a sentence or two ("IAM roles
  belong to the account and work in every region. The rest lives in one
  region.").
- **Look at it.** Run `scripts/diagram-sheet.py /tmp/sheet.png <path>…` against
  the dev server and read the sheet. Overlapping labels, labels on borders,
  overflowing text, missing edges and cramped short edges don't show up any
  other way.

## Build

From `website/`:

```sh
pnpm exec astro build   # fast: pages only (~1300)
pnpm run build          # full: brand assets, API reference, llms, then astro
```

Run the full build before pushing a change that adds or moves pages. The dev
server (`pnpm exec astro dev`, http://localhost:4321) hot-reloads for
screenshots.
