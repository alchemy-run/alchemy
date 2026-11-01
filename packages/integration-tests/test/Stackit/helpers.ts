import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

/**
 * `Test.make` preset for STACKIT suites. Live suites run against the
 * `testing` profile: `pnpm test:integration test/Stackit --profile testing`.
 * The profile's project is the sandbox every suite deploys into.
 */
export const makeStackitTest = () => Test.make({ providers: Stackit.providers() });

/** Debug logs with `DEBUG=1`, info otherwise. */
export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Standard tags for a live STACKIT test: `provider:stackit`, one
 * `provider:stackit:<part>` per part (namespace, resource), and `live`.
 *
 * ```ts
 * { tags: stackitTags("dns", "zone"), timeout: 180_000 }
 * ```
 */
export const stackitTags = (...parts: ReadonlyArray<string>): string[] => [
  "provider:stackit",
  ...parts.map((part) => `provider:stackit:${part.toLowerCase()}`),
  "live",
];

/** The profile's default project, region and organization. */
export const stackitEnvironment = Stackit.StackitEnvironment.current;
