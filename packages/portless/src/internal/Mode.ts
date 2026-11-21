import * as Config from "effect/Config";

/**
 * Whether the run opts out of the proxy: `PORTLESS` is `0`, `false` or `skip`,
 * as in Portless itself. Unset, or any other value, is `false`.
 *
 * While it is `true` there is no proxy to name anything: `Proxy` starts
 * nothing, `Dev` serves `http://localhost:<port>`, `Alias` returns its `url`
 * and `Origin` returns `http://localhost:<port>`. A stack that builds its own
 * addresses reads it to know whether its origins are Portless names or ports.
 *
 * ```typescript
 * const disabled = yield* Portless.disabled;
 * ```
 */
export const disabled = Config.String("PORTLESS").pipe(
  Config.withDefault(""),
  Config.map((value) => value === "0" || value === "false" || value === "skip"),
);

/** Where a service listens when there is no proxy to name it. */
export const localOrigin = (port: number) => `http://localhost:${port}`;
