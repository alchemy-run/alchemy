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

The caption sits under the panel, outside its border, as a note, so the
drawing gets the whole panel. A new component wraps its drawing in
`<div class="alc-fig__panel">` and puts the `figcaption` after it. A `DAG` grid
starts at its first used `col` and `row`, so number them from 0.

**Every diagram uses its panel.** The SVG's viewBox wraps what's drawn with an
even margin, never room kept for something absent (a back-edge gutter on both
sides, a zone border before a column with no zone, padding for a self-loop no
state has). Look at the diagrams, not a linter: an audit script that flagged
margins, fill and scale was cut because everything it flagged looked fine.
Fix the component, not the page.

| The section answers | Component | Good example |
| --- | --- | --- |
| What holds what, and what calls what? What is the platform made of? | `Tree` with `links`: borders for containment, arrows for calls, placed with `areas` so it reflows to a phone. See [Tree: borders and arrows](#tree-borders-and-arrows) | `aws/what-is-aws`, `cloudflare/what-is-cloudflare`, `gcp/what-is-gcp` |
| What connects to what, and what flows where? (rarely: reach for a component below first) | `DAG` (arrows) | `aws/frontend/websites` |
| Where does one event or message go, and why? Routing by content, broadcast copies, filters | `Fanout` (the item's JSON, each route's condition, match or not). No labels sitting on a line: a "copy" chip on each delivery was rejected | `aws/messaging/eventbridge`, `aws/messaging/sns` |
| What's in a queue right now, and who holds what? | `Queue` (`messages` for a standard queue in no order, `groups` for FIFO message groups) | `aws/messaging/sqs` |
| How do compute and shared storage spread over zones? | `Zones` | `aws/data/rds` |
| What can reach what across a boundary? Tunnels, login walls, signed webhooks, private services | `Boundaries` (zones as borders, a `tunnel` arrow through a dotted gap in the wall, a `blocked` path ending in a cross) | `cloudflare/networking/tunnel`, `cloudflare/security/access`, `gcp/networking/private-services` |
| Who manages each layer, you or the platform? | `Responsibility` | `aws/compute/choosing-a-runtime` |
| In what order do messages pass between parties, when that order *is* the idea? A protocol, a token exchange, receive-hide-delete | `Sequence`, sparingly (about a dozen across the docs) | `aws/messaging/sqs`, `gcp/security/federated-identity`. Never on a What is page |
| What runs when? Concurrency, waiting, propagation | `Timeline` | `aws/compute/lambda`, `cloudflare/data/kv` |
| Where in the world does it run? | `WorldMap` | `cloudflare/compute/durable-objects`, `cloudflare/data/hyperdrive` |
| What is ordered, and who has read how far? | `Log` | `cloudflare/messaging/k2`, `aws/messaging/kinesis` |
| What states does it move through? | `StateMachine` | `cloudflare/messaging/queues`, `stripe/guides/subscriptions` |
| How is data laid out, what does a query read, what does a log hold? | `Records` | `aws/data/dynamodb`, `cloudflare/ai/ai-gateway` (a request log), `cloudflare/data/pipelines` (the rows SQL keeps) |
| How does a value or a line of code travel from deploy to run time? | `Timeline` (what runs when) or `Sequence` (a value's journey) | `infrastructure-as-effects/phases`, `infrastructure-as-effects/circular-bindings` |
| How do copies relate over time? | `BranchGraph` | `neon/data/branching` |
| What runs inside what? A library's Layers inside the runtime that hosts them | `Shell`: boxes inside boxes, read like a call, `Worker(Git.Api(Repository, Registry, …))`. Only for real nesting: an authority does not contain an account, and an order does not contain its certificate | `git/what-is-git` |
| What nests inside what, to any depth, and what applies to each branch? | `Tree` without `links`: nested borders, each parent drawn around its children, spanning the panel with every row filled; mark small branches `side` so they stack beside a big one instead of taking a mostly empty row (`scopes` tag the container a policy is attached to; `dashed`, `wide`, `specs` for a box's own properties) | `aws/accounts-and-regions`, `aws/compute/ec2`, `aws/compute/eks` |

Each component's JSDoc has its props and a usage example. Read it before using
one.

Rules for every diagram:

- **One idea per diagram**, the one its section explains. If the caption needs
  "and also", draw two, or cut one.
- **Show the behaviour, not the boxes.** A Lambda section is about one
  invocation per environment, so draw environments over time (`Timeline`), not
  a box called "environment". An SQS section is about receive, hide and delete,
  so draw the queue's contents (`Queue`), then the receive, hide and delete
  (`Sequence`). Ask what a reader would get wrong, and draw that.
- **A property is not a node.** An instance's type and image, a table's key
  schema, a function's memory: write them inside the thing's box (`specs` on
  `Tree`), never as separate boxes with arrows labelled "size" or "boots".
- **Use real names and values** from the page's own example: `"user#sam"`,
  `getByName("lobby")`, `weur`, `maxRetries`, offsets, sizes, cities.
- **Containment is a border, never an arrow.** Arrows are only for things that
  move or call. Group ids and node ids must differ.
- **Never a table of text in boxes.** A grid of cells holding sentences, half
  of them empty dashes, was rejected: it shows nothing a paragraph doesn't. So
  was a truth-table grid of allowed/denied (IAM across accounts): draw the call
  passing its checks instead. If
  the cells would be sentences, draw the movement or the timing instead.
- **A diagram with no arrows and no meaningful borders is the wrong
  component.** Use a purpose-made one, or build a new one in
  `diagrams/` in the same style when no existing one answers the question.
- **No long empty edges.** Don't push a node columns away to make room for an
  edge label; put the detail in the node's type (`SendMessage on Jobs`) and keep
  neighbours adjacent.
- **Keep it compact.** Two or three columns read better than a row of five.
  Crop a `WorldMap` to the region that matters (`crop`), and set `center={180}`
  for a route across the Pacific.
- **Keep labels short**: about 16 characters for a box label and 20 for its
  type. A label that doesn't fit a short bar or edge belongs in a `legend` or
  the caption.
- **The caption says what the picture means**, in a sentence or two.
- **Check a Tree at both widths.** Run `node scripts/tree-check.mjs
  http://localhost:4321 /tmp/trees <path>…` (or `--all`) against the dev
  server. It measures every Tree at 1280px and 390px and fails on boxes that
  don't sit flush, text spilling out, arrows with no clear route, arrows that
  cross or overlap, arrows through a heading, arrowheads on short stubs, and
  labels on a border, line, text or another label, and any gutter no arrow
  uses. It also screenshots every
  figure at both widths, so read those too: a clean report is necessary, not
  sufficient. Fix what it reports before showing anyone.
- **Look at it.** Run `scripts/diagram-sheet.py /tmp/sheet.png <path>…` against
  the dev server and read the sheet (`SHEET_SCALE=1` for long pages). The sheet
  shrinks every diagram to one width, so also screenshot the real page
  (`scripts/screenshot.sh`) to check the text is readable at the column's
  width. Overlapping labels, overflowing text,
  missing edges and clipped bottoms don't show up any other way.

### Tree: borders and arrows

A What is page draws the platform's pieces, where they live and how they call
each other. Containment and connections are both the point, so draw both:
borders for what holds what, `links` for what calls what. A Tree that wrote its
connections as text inside boxes (`specs: [["binds", "Uploads · Rooms · Jobs"]]`)
was rejected: "I don't think much thought is going into how the boxes envelope
and connect to each other". The redraw with arrows was accepted.

```tsx
<Tree
  nodes={[
    {
      id: "account", label: "acme", type: "account", icon: "brand:cloudflare", colGap: 2.75,
      areas: ["zone api uploads", "zone api rooms", "zone api jobs", "zone api consumer"],
    },
    { id: "zone", label: "example.com", type: "zone", parent: "account", dashed: true, icon: "globe" },
    { id: "domain", label: "app.example.com", type: "custom domain", parent: "zone", icon: "link" },
    { id: "api", label: "Api", type: "Worker · every city", parent: "account", tone: "accent", icon: "square-function" },
    // …uploads, rooms (a namespace holding room-a, room-b), jobs, consumer
  ]}
  links={[
    { from: "domain", to: "api", label: "routes" },
    { from: "api", to: "rooms", label: "binds" },   // ends on the namespace's border
    { from: "jobs", to: "consumer", label: "delivers", dashed: true },
  ]}
/>
```

- **A connection is an arrow, a property is `specs`.** "binds", "mounts",
  "runs as", "reaches", "from", "points at", "selects" are arrows. An
  instance's size, a pod's schedule, a token's scope stay as `specs`. A type
  line that hides a connection ("Service · selects app=api") is the same
  mistake.
- **Label arrows with a short verb**: `binds`, `mounts`, `runs as`, `reads`,
  `writes`, `from`, `invokes`, `:5432`. Use `dashed` for what the platform
  delivers (a queue to its consumer, a webhook, a sync), solid for calls you
  make. Leave a label off when the caption says it and two labels would crowd.
- **An arrow ends where the relationship does.** A Worker binds a namespace,
  so the arrow ends on the namespace's border, not on one object in it. Api
  runs as a Role that belongs to the account, so the arrow leaves the region.
- **Draw what's outside the platform** when the page talks about it (your
  Worker, your own bucket): a top-level node, placed with the Tree's own
  `areas`.
- **Place boxes so every arrow is short and straight.** Give a container
  `areas` (CSS grid-template-areas naming child ids) and set `colGap` so the
  labels fit: about 6.3px a character plus 10. Lay the flow out left to right:
  callers on the left, what they call on the right, a box spanning several rows
  when it calls several things. Placed boxes keep their own height and centre
  in the rows they span. Don't stretch them to fill the space. Keep it to
  three columns: four didn't fit the ~590px column.
- **Design the phone layout too.** Without `phoneAreas`, a container's
  children stack in node order, so order nodes in the direction the arrows
  flow. Give two-column `phoneAreas` when an arrow would otherwise have to
  cross a box (put the targets side by side under their caller). Arrows that
  still must go around boxes run down a left gutter and branch off. The router
  opens that gutter itself, only in the container that needs it and only at
  the width where it's needed: a gutter kept for arrows that ran straight was
  rejected as wasted whitespace. It's wide enough that each branch has a
  visible stub before its arrowhead (a head on a 10px stub looked like a blob).
- **Mind headings.** A straight arrow can't enter a container through its
  heading, so a target that is a container's first child is reached from the
  side or from below. Put the caller below, or the target in the right-hand
  column, clear of the heading text.
- **The router picks, in order**: straight down or across where two boxes
  overlap, one bend, then around through the gutter. It never crosses a box,
  a heading, or another arrow unless nothing else is possible. Arrows from one
  box, or into one box, may share a trunk. Labels go on the longest clear part
  of the line, never on a border, line, text or other label. When the checker
  still finds a problem, change the layout (`areas`, `phoneAreas`, node order,
  `colGap`), not the router.

### Component gotchas

- A `caption="…"` is a JSX string: `\"` doesn't escape a quote inside it and the page fails to render (the sheet shows 0 diagrams). Use single quotes inside, `getByName('alice')`, or none.
- `side` works only on a node with a parent. Top-level nodes stack unless the Tree itself has `areas`: use that to put something outside the platform (your Worker, your bucket) beside it.

Each of these came up on a sheet and was fixed:

- **Boundaries:** lay it out top to bottom (`row`, `col`) so it fits the
  column; four columns across render too small to read. Put the caller and the
  edge across the top and the guarded zone below. A vertical link enters a
  zone's top-left, so give that zone `labelAt: "right"`. A `blocked` path drops
  straight down into the zone's side wall when its column is clear, and
  otherwise runs over the top to the wall. A `tunnel` is a plain arrow, with a
  dotted gap where it crosses the wall. A rounded pipe around the arrow was
  rejected.
- **Fanout:** never put a chip or label on top of a line. A "copy" box on each
  delivery was rejected. Say "each gets its own copy" in the caption.
- **Tree:** the tree spans the panel. In an unplaced row, boxes stretch to the
  row's height and a container's contents grow to fill it, so everything ends
  flush (ragged rows and empty space under a container were rejected). `side`
  stacks small siblings in a column beside a big one instead of leaving an
  empty row. `specs` writes a box's own properties inside it. For arrows, see
  [Tree: borders and arrows](#tree-borders-and-arrows).
- **Sequence:** actor boxes widen to fit their label and type. Keep at most four
  or five actors, or the labels get small.

- **Timeline:** at `end={10}` one unit is about 56px, and a bar's label needs
  about 6.4px a character plus 12. A label that doesn't fit spills after the bar
  and runs into the next one, so widen the bar, shorten the label, or drop it
  and add a `legend` (cold starts, waits, failures).
- **Sequence:** keep arrow labels shorter than the gap between lifelines
  (about 24 characters for neighbours). Notes and self-loops size themselves.
  Use `dashed` for replies and later deliveries, `tone: "warn"` for the bad
  path, and a `divider` to start an alternative ("or, if the Worker crashes").
- **WorldMap:** two places closer than about 10° overlap, so move one to a
  nearby real city (Madrid rather than Paris next to Amsterdam). Label only the
  arc with the most room, and let the caption cover the rest. `crop` to the
  region, and `center={180}` for a route across the Pacific.
- **Log:** a cursor `below` a lane needs room under it; it's there, but check
  the label isn't clipped. Keep records short (`#1 paid`, `INSERT #1`).
- **StateMachine:** a pair of opposite transitions needs `bend` around 0.7 on
  both, or their labels overlap.
- **Records:** order rows the way the store keeps them (lexicographic keys) and
  highlight exactly what the query returns.

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
