import type * as Effect from "effect/Effect";

export type LifecycleHandlers<Input, Output> = {
  create(input: {
    id: string;
    news: Input;
  }): Effect.Effect<Output, never, never>;
  update(input: {
    id: string;
    news: Input;
    olds: Input;
  }): Effect.Effect<Output, never, never>;
  delete(input: {
    id: string;
    olds: Input;
    output: Output;
  }): Effect.Effect<void, never, never>;
};
