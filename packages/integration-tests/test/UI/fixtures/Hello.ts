import { Component, html, Intent, Signal } from "@alchemy.run/ui";
import * as Effect from "effect/Effect";

export class Hello extends Component.Tag<Hello>()("Hello") {}

export const HelloLive = Hello.make(
  Effect.fn(function* () {
    const clicks = yield* Signal.state("clicks", 0);
    const clicked = yield* Intent.make(
      "Clicked",
      clicks.update((n) => n + 1),
    );

    return html.div(
      html.h1("Hello, world"),
      html.p(Signal.map(clicks, (n) => `Clicked ${n} times`)),
      html.button({ onClick: clicked }, "Click me"),
    );
  }),
);
