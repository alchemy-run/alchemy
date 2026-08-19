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

// Minted on first ask rather than at module scope: this module is pulled into
// the Worker bundle too, and workerd refuses to generate random values in
// global scope ("Disallowed operation called within global scope") — which
// fails the whole script at startup, not just this fixture. Either way the id
// is per-process, which is all the test reads it for.
let bootId: string | undefined;

export default WarmContainer.make(
  {
    main: import.meta.filename,
    dockerfile: Dockerfile.inline`FROM oven/bun:latest`,
  },
  Effect.gen(function* () {
    return {
      ping: () => Effect.succeed("pong"),
      boot: () => Effect.sync(() => (bootId ??= crypto.randomUUID())),
    };
  }),
);
