import { Component, html, Intent, Signal } from "@alchemy.run/ui";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => Effect.Effect<string> }
>()("Greeter") {}

export class Greeting extends Component.Tag<Greeting>()("Greeting") {}

export const GreetingLive = Greeting.make(
  Effect.fn(function* () {
    const greeter = yield* Greeter;

    const name = yield* Signal.state("name", "");
    const reply = yield* Signal.state("reply", Option.none<string>());

    const typed = yield* Intent.make("Typed", Schema.String, (text) => name.set(text));
    const greet = yield* Intent.make(
      "Greet",
      Effect.gen(function* () {
        const text = yield* name.get;
        const answer = yield* greeter.greet(text);
        yield* reply.set(Option.some(answer));
      }),
    );

    return html.div(
      html.input({ value: name, onInput: typed.from((e) => e.currentTarget.value) }),
      html.button({ onClick: greet, disabled: Signal.map(name, (n) => n === "") }, "Greet"),
      html.p(
        Signal.map(
          reply,
          Option.getOrElse(() => "…"),
        ),
      ),
    );
  }),
);
