import type { DeckItem } from "./shared/types.ts";

/**
 * The presentation, in order. Slides are designed in React
 * (`remotion/slides/`); scenes are real demos recorded by `capture.ts` from
 * `scenes/<id>.ts`, each ending at `chapters/<id>`. Each item becomes one
 * scene in the presenter.
 */
const chapter = (
  n: number,
  id: string,
  heading: string,
  subtitle: string,
): DeckItem[] => [
  {
    kind: "slide",
    id: `${id}-intro`,
    title: `${n}. ${heading}`,
    notes: subtitle,
    layout: "section",
    props: { eyebrow: `Chapter ${n}`, heading, subtitle },
    seconds: 2,
  },
  { kind: "scene", id },
];

export const deck: DeckItem[] = [
  { kind: "intro", id: "intro" },
  {
    kind: "slide",
    id: "build",
    title: "Let's build something",
    notes: "Enough theory: let's build a service from an empty folder to production, and watch the architecture grow as we go.",
    layout: "section",
    props: { eyebrow: "Demo", heading: "Let's build something", subtitle: "From an empty folder to production" },
    seconds: 2,
  },
  ...chapter(0, "00-website", "A Stack and a website", "Declare the Stack, run it with alchemy dev"),
  ...chapter(1, "01-api", "An Effectful Worker", "An HttpApi served by a Worker, called by a typed client"),
  ...chapter(2, "02-d1", "Store links in D1", "A database, its migrations, and a binding"),
  ...chapter(3, "03-tests", "Test against the real cloud", "Deploy a copy, assert, destroy"),
  ...chapter(4, "04-durable-objects", "Durable Objects", "Per-link state and hibernatable WebSockets"),
  ...chapter(5, "05-queues", "Queues", "Count clicks off the hot path, as an Effect Stream"),
  ...chapter(6, "06-layers-neon", "Storage as a Layer", "Swap D1 for Neon Postgres behind Hyperdrive"),
  ...chapter(7, "07-telemetry", "OpenTelemetry", "Spans and logs to Axiom"),
  ...chapter(8, "08-dashboard", "Dashboards as code", "An Axiom dashboard next to the code it observes"),
  ...chapter(9, "09-deploy", "Ship it", "Built with alchemy dev, proven by tests, deployed once"),
  {
    kind: "slide",
    id: "recap",
    title: "Recap",
    notes: "Recap each step and point to alchemy.run. alchemy deploy --stage prod stands up the whole thing as a second environment.",
    layout: "bullets",
    props: {
      heading: "What we built",
      bullets: [
        "A Worker, a website and an API",
        "D1, then Neon, behind one Layer",
        "Durable Objects, WebSockets and Queues",
        "Real-cloud tests on every change",
        "Telemetry and a dashboard, as code",
      ],
    },
    seconds: 3,
  },
];
