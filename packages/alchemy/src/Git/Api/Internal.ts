/**
 * The engine's internal API: routes the engine calls on itself, never a
 * user. Mounted by `Git.Server` next to your API, outside your middleware.
 */
import * as Http from "../../Http/index.ts";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { HASH_ROUTE } from "../Hasher/Protocol.ts";

/**
 * The push pipeline's hashing endpoint (DESIGN §22.7), reached through the
 * Worker's self service binding by the fan-out {@link Hasher} and
 * authenticated with the deploy-time internal secret, never a user
 * credential.
 */
export class HashPart extends Http.post<HashPart>()("hashPart", HASH_ROUTE) {}

/** The internal group, mounted at the root. */
export class Internal extends HttpApiGroup.make("internal", {
  topLevel: true,
}).add(HashPart) {}

/**
 * The internal API. `Git.Server` mounts it for you; a host that builds
 * its router by hand and uses a fan-out hasher mounts it too:
 * `HttpApiBuilder.layer(Git.InternalApi)` with `Http.handlers(Git.InternalApi)`.
 */
export class InternalApi extends HttpApi.make("git-internal").add(Internal) {}
