import type * as Effect from "effect/Effect";
import type { Resource } from "./resource.ts";

export type Diff =
  | {
      action: "update" | "noop";
      deleteFirst?: undefined;
    }
  | {
      action: "replace";
      deleteFirst?: boolean;
    };

export type Provider<Res extends Resource = Resource> = {
  // tail();
  // watch();
  // replace(): Effect.Effect<void, never, never>;
  kind: "Provider";
  type: Res["Type"];
  read?(input: {
    id: string;
    olds: Res["Props"] | undefined;
    // what is the ARN?
    output: Res["Attr"] | undefined; // current state -> synced state
  }): Effect.Effect<Res["Attr"] | undefined, any, never>;
  diff?(input: {
    id: string;
    olds: Res["Props"];
    news: Res["Props"];
    output: Res["Attr"];
  }): Effect.Effect<Diff, never, never>;
  stub?(input: {
    id: string;
    news: Res["Props"];
  }): Effect.Effect<Res["Attr"], any, never>;
  create(input: {
    id: string;
    news: Res["Props"];
  }): Effect.Effect<Res["Attr"], any, never>;
  update(input: {
    id: string;
    news: Res["Props"];
    olds: Res["Props"];
    output: Res["Attr"];
  }): Effect.Effect<Res["Attr"], any, never>;
  delete(input: {
    id: string;
    olds: Res["Props"];
    output: Res["Attr"];
  }): Effect.Effect<void, any, never>;
};
