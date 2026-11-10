import workerdModule from "alchemy/Workers/Workerd/Module";
import type * as Effect from "effect/Effect";

const cloudflare_workers = workerdModule as unknown as Effect.Effect<
  typeof import("cloudflare:workers")
>;

export default cloudflare_workers;
