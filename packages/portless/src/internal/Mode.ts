import * as Config from "effect/Config";

/** `PORTLESS=0` (or `false`, `skip`) opts out of the proxy, as it does in Portless itself. */
export const disabled = Config.String("PORTLESS").pipe(
  Config.withDefault(""),
  Config.map((value) => value === "0" || value === "false" || value === "skip"),
);

/** Where a service listens when there is no proxy to name it. */
export const localOrigin = (port: number) => `http://localhost:${port}`;
