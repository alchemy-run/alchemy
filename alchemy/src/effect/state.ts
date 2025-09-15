import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { App } from "./app.ts";

export class State extends Context.Tag("AWS::Lambda::State")<
  State,
  {
    get(id: string): Effect.Effect<any, never, never>;
    set(id: string, value: any): Effect.Effect<void, never, never>;
    delete(id: string): Effect.Effect<void, never, never>;
    list(): Effect.Effect<string[], never, never>;
  }
>() {}

// TODO(sam): implement with SQLite3
export const local = Layer.effect(
  State,
  Effect.gen(function* () {
    const app = yield* App;
    return {
      get: Effect.fn(function* (id: string) {
        return {};
      }),
      set: Effect.fn(function* (id: string, value: any) {
        return {};
      }),
      delete: Effect.fn(function* (id: string) {
        return {};
      }),
      list: Effect.fn(function* () {
        return [];
      }),
    };
  }),
);

export const inMemory = Layer.effect(
  State,
  Effect.gen(function* () {
    const state = new Map<string, any>();
    return {
      get: Effect.fn(function* (id: string) {
        return state.get(id);
      }),
      set: Effect.fn(function* (id: string, value: any) {
        state.set(id, value);
      }),
      delete: Effect.fn(function* (id: string) {
        state.delete(id);
      }),
      list: Effect.fn(function* () {
        return Array.from(state.keys());
      }),
    };
  }),
);
