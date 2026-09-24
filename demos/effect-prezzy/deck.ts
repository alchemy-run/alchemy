import type { DeckItem } from "./shared/types.ts";

/**
 * The presentation, in order. Slides are designed in React
 * (`remotion/slides/`); scenes are real demos recorded by `capture.ts` from
 * `scenes/<id>.ts`, each ending at `chapters/<id>`. Each item becomes one
 * scene in the presenter.
 */
/** A recorded chapter. Each step's title is shown over the code as it plays. */
const chapter = (id: string): DeckItem => ({ kind: "scene", id });

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
  chapter("00-website"),
  chapter("01-api"),
  chapter("02-d1"),
  chapter("03-tests"),
  chapter("04-durable-objects"),
  chapter("05-queues"),
  chapter("06-layers-neon"),
  chapter("07-telemetry"),
  chapter("08-dashboard"),
  chapter("09-deploy"),
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
