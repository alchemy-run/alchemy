import { describe, expect, it } from "@alchemy.run/test";
import { Story } from "@alchemy.run/ui";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Greeter, Greeting, GreetingLive } from "./fixtures/Greeting.ts";
import { Hello, HelloLive } from "./fixtures/Hello.ts";

const hello = { component: Hello, layer: HelloLive };
const greeting = {
  component: Greeting,
  layer: GreetingLive.pipe(Layer.provide(Story.external(Greeter))),
};

describe("UI Story", { tags: ["unit"] }, () => {
  it.effect("starts at zero", () =>
    Story.story(hello, Story.mount(), Story.state("clicks", 0), Story.renders("Clicked 0 times")),
  );

  it.effect("each click counts once", () =>
    Story.story(
      hello,
      Story.mount(),
      Story.when("Clicked"),
      Story.wrote("clicks", 1),
      Story.when("Clicked"),
      Story.state("clicks", 2),
      Story.renders("Clicked 2 times"),
    ),
  );

  it.effect("starts from given state", () =>
    Story.story(
      hello,
      Story.mount(),
      Story.given("clicks", 99),
      Story.when("Clicked"),
      Story.wrote("clicks", 100),
    ),
  );

  it.effect("greets by name once the greeter answers", () =>
    Story.story(
      greeting,
      Story.mount(),
      Story.when("Typed", "Sam"),
      Story.wrote("name", "Sam"),
      Story.when("Greet"),
      Story.call(Greeter, "greet", "Sam"),
      Story.renders("…"),
      Story.succeed(Greeter, "greet", "Hello, Sam"),
      Story.wrote("reply", Option.some("Hello, Sam")),
      Story.renders("Hello, Sam"),
    ),
  );

  it.effect("a wrong expectation fails the story with the step and the values", () =>
    Effect.gen(function* () {
      const error = yield* Story.story(
        hello,
        Story.mount(),
        Story.when("Clicked"),
        Story.state("clicks", 5),
      ).pipe(Effect.flip);
      expect(error.step).toBe("state clicks");
      expect(error.reason).toBe("expected 5, got 1");
    }),
  );

  it.effect("a call the story doesn't expect fails it", () =>
    Effect.gen(function* () {
      const error = yield* Story.story(
        greeting,
        Story.mount(),
        Story.when("Typed", "Sam"),
        Story.when("Greet"),
        Story.call(Greeter, "greet", "Max"),
      ).pipe(Effect.flip);
      expect(error.reason).toBe('expected arguments ["Max"], got ["Sam"]');
    }),
  );
});

// Stories are checked against the model the constructor declares. These never
// run; they only have to fail to type-check.
export const typeErrors = () => [
  // @ts-expect-error: Hello has no Intent "Clickd"
  Story.story(hello, Story.mount(), Story.when("Clickd")),
  // @ts-expect-error: clicks is a number
  Story.story(hello, Story.mount(), Story.state("clicks", "2")),
  // @ts-expect-error: Hello has no state "count"
  Story.story(hello, Story.mount(), Story.state("count", 1)),
  // @ts-expect-error: Typed needs a string payload
  Story.story(greeting, Story.mount(), Story.when("Typed")),
  // @ts-expect-error: Greet takes no payload
  Story.story(greeting, Story.mount(), Story.when("Greet", "Sam")),
  // @ts-expect-error: greet takes a string
  Story.story(greeting, Story.mount(), Story.call(Greeter, "greet", 1)),
  // @ts-expect-error: the layer still needs a Greeter
  Story.story({ component: Greeting, layer: GreetingLive }, Story.mount()),
];
