import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

type IsAny<T> = 0 extends 1 & T ? true : false;

type UpgradeServices = Effect.Services<ReturnType<typeof Cloudflare.upgrade>>;

// `any` in the requirements absorbs every other requirement of the handler
// that yields it, so a missing service would no longer be a type error.
const _upgradeServicesAreNotAny: IsAny<UpgradeServices> = false;

// Accepting a WebSocket needs the Durable Object's state and the runtime
// context that the state's `acceptWebSocket` runs in.
const _upgradeServices: [UpgradeServices] extends [Cloudflare.DurableObjectState | RuntimeContext]
  ? true
  : false = true;
