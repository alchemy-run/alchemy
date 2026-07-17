import * as Cloudflare from "@/Cloudflare";
import * as Dockerfile from "@/Docker/Dockerfile.ts";
import * as Effect from "effect/Effect";

/**
 * Minimal effectful container for exercising `keepWarm` / `warmPool`.
 *
 * `boot` returns an id generated once per container *process*, so a test can
 * tell a genuinely restarted container from one that never went down: the id
 * changes if and only if the process was replaced.
 */
export class WarmContainer extends Cloudflare.Container<
  WarmContainer,
  {
    ping: () => Effect.Effect<string>;
    boot: () => Effect.Effect<string>;
  }
>()("WarmContainer") {}

const bootId = crypto.randomUUID();

export default WarmContainer.make(
  {
    main: import.meta.filename,
    dockerfile: Dockerfile.inline`FROM oven/bun:latest`,
  },
  Effect.gen(function* () {
    return {
      ping: () => Effect.succeed("pong"),
      boot: () => Effect.succeed(bootId),
    };
  }),
);
