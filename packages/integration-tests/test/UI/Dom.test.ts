import { describe, expect, it } from "@alchemy.run/test";
import { Component, Dom, html, Intent, Signal } from "@alchemy.run/ui";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Window } from "happy-dom";
import { Greeter, Greeting, GreetingLive } from "./fixtures/Greeting.ts";
import { Hello, HelloLive } from "./fixtures/Hello.ts";

const makeContainer = () => {
  const window = new Window();
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  return { window, container: container as unknown as Element };
};

/** Handlers run as fibers; let them run until `check` holds. */
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !check(); i++) yield* Effect.yieldNow;
    expect(check()).toBe(true);
  });

const click = (el: Element | null) => (el as HTMLElement).click();

// Counts how often each derived value is recomputed, so the test can see what
// a write touches.
let parityRuns = 0;
let consistent = true;

class Parity extends Component.Tag<Parity>()("Parity") {}

const ParityLive = Parity.make(
  Effect.fn(function* () {
    const count = yield* Signal.state("count", 1);
    const doubled = Signal.map(count, (n) => n * 2);
    const parity = Signal.map(count, (n) => (n % 2 === 0 ? "even" : "odd"));
    const shown = Signal.map(parity, (p) => {
      parityRuns++;
      return p;
    });
    const check = Signal.map(Signal.all([count, doubled]), ([c, d]) => {
      if (d !== c * 2) consistent = false;
      return `${c}×2=${d}`;
    });
    const addTwo = yield* Intent.make(
      "AddTwo",
      count.update((n) => n + 2),
    );
    const addOne = yield* Intent.make(
      "AddOne",
      count.update((n) => n + 1),
    );
    return html.div(
      html.span({ id: "parity" }, shown),
      html.span({ id: "check" }, check),
      html.button({ id: "two", onClick: addTwo }, "+2"),
      html.button({ id: "one", onClick: addOne }, "+1"),
    );
  }),
);

describe("UI Dom", { tags: ["unit"] }, () => {
  it.effect("a click rewrites only the text bound to the signal", () =>
    Effect.gen(function* () {
      const { container } = makeContainer();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Dom.render(Hello, container);
          const p = container.querySelector("p")!;
          const text = p.firstChild;
          const heading = container.querySelector("h1");
          expect(p.textContent).toBe("Clicked 0 times");

          click(container.querySelector("button"));
          yield* until(() => p.textContent === "Clicked 1 times");

          // The same nodes, updated in place: nothing re-rendered.
          expect(p.firstChild).toBe(text);
          expect(container.querySelector("h1")).toBe(heading);
        }),
      );
    }).pipe(Effect.provide(HelloLive)),
  );

  it.effect("unmounting removes the DOM and stops listening", () =>
    Effect.gen(function* () {
      const { container } = makeContainer();
      let button: Element | null = null;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Dom.render(Hello, container);
          button = container.querySelector("button");
        }),
      );
      expect(container.childNodes.length).toBe(0);
      click(button);
      yield* Effect.yieldNow;
      expect(container.textContent).toBe("");
    }).pipe(Effect.provide(HelloLive)),
  );

  it.effect("inputs, derived attributes and service calls work in the browser", () =>
    Effect.gen(function* () {
      const { window, container } = makeContainer();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Dom.render(Greeting, container);
          const input = container.querySelector("input") as HTMLInputElement;
          const button = container.querySelector("button")!;
          const p = container.querySelector("p")!;
          expect(button.hasAttribute("disabled")).toBe(true);

          input.value = "Sam";
          input.dispatchEvent(new window.Event("input") as unknown as Event);
          yield* until(() => !button.hasAttribute("disabled"));

          click(button);
          yield* until(() => p.textContent === "Hello, Sam!");
        }),
      );
    }).pipe(
      Effect.provide(
        GreetingLive.pipe(
          Layer.provide(
            Layer.succeed(Greeter, { greet: (name) => Effect.succeed(`Hello, ${name}!`) }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "a derived value that doesn't change stops there, and nothing sees a half-updated graph",
    () =>
      Effect.gen(function* () {
        parityRuns = 0;
        consistent = true;
        const { container } = makeContainer();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Dom.render(Parity, container);
            const parity = container.querySelector("#parity")!;
            const check = container.querySelector("#check")!;
            expect(parityRuns).toBe(1);

            click(container.querySelector("#two"));
            yield* until(() => check.textContent === "3×2=6");
            // 1 → 3: still odd, so nothing downstream of parity re-ran.
            expect(parityRuns).toBe(1);
            expect(parity.textContent).toBe("odd");

            click(container.querySelector("#one"));
            yield* until(() => parity.textContent === "even");
            expect(parityRuns).toBe(2);
            expect(consistent).toBe(true);
          }),
        );
      }).pipe(Effect.provide(ParityLive)),
  );
});
