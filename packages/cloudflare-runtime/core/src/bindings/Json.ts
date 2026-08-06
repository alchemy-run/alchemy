import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext";

export const local = (binding: string, json: any): BindingHook =>
  Effect.succeed({
    name: binding,
    json: JSON.stringify(json),
  });
