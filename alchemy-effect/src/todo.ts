import * as Effect from "effect/Effect";

export const todo = (message?: string) =>
  Effect.dieMessage(message ?? `Not implemented`);
