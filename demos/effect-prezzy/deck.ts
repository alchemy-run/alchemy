import type { DeckItem } from "./shared/types.ts";

/**
 * The presentation, in order. Slides are designed in React
 * (`remotion/slides/`); scenes are real demos recorded by `capture.ts` from
 * `scenes/<id>.ts`. Each item becomes one scene in the presenter.
 */
export const deck: DeckItem[] = [
  {
    kind: "slide",
    id: "title",
    title: "Title",
    notes: "Intro: who I am, what we're building today.",
    layout: "title",
    props: {
      eyebrow: "Alchemy",
      heading: "Building an app end to end",
      subtitle: "Infrastructure as Effects",
    },
  },
  {
    kind: "slide",
    id: "outline",
    title: "Outline",
    notes: "Placeholder outline; replace once the content is agreed.",
    layout: "bullets",
    props: {
      heading: "What we'll build",
      bullets: [
        "A Vite website",
        "An Effect Worker backend",
        "Infrastructure as Layers",
        "Deploy it",
      ],
    },
  },
  { kind: "scene", id: "deploy-website" },
];
