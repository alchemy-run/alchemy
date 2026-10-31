import * as Effect from "effect/Effect";
import { AliasUrlInvalid } from "../Errors.ts";

/** The hosts Portless can forward to: it dials the port over both loopback addresses. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The port a url names, when it is a loopback `http://` url. The proxy only
 * forwards plain HTTP to a port on this machine, so anything else can't be
 * routed to and fails with what to change.
 */
export const portOf = (url: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(url),
      catch: () => new AliasUrlInvalid({ url, reason: "it is not a url" }),
    });
    if (parsed.protocol !== "http:") {
      return yield* new AliasUrlInvalid({
        url,
        reason: "the proxy forwards plain HTTP to the port, so only http:// urls can be aliased",
      });
    }
    if (!LOOPBACK.has(parsed.hostname)) {
      return yield* new AliasUrlInvalid({
        url,
        reason: "only loopback addresses can be aliased: localhost, 127.0.0.1 or [::1]",
      });
    }
    return parsed.port === "" ? 80 : Number(parsed.port);
  });
