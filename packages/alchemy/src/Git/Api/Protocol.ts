/**
 * The `protocol` group: git smart HTTP v0 at the repository's root path,
 * plus the push pipeline's internal hash route. The routes are streaming
 * binary (pkt-lines in, sideband packs out) and answer with the response
 * they build; they declare no schemas beyond the middleware they rely on.
 *
 * `:repo` may carry a `.git` suffix; the handlers strip it.
 */
import * as Http from "../../Http/index.ts";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Authenticated } from "../Auth.ts";
import { HASH_ROUTE } from "../Hasher/Protocol.ts";

/** `GET /:owner/:repo/info/refs?service=…`: the ref advertisement. */
export class InfoRefs extends Http.get<InfoRefs>()(
  "infoRefs",
  "/:owner/:repo/info/refs",
  { middleware: [Authenticated] },
) {}

/** `POST /:owner/:repo/git-upload-pack`: clone and fetch. */
export class UploadPack extends Http.post<UploadPack>()(
  "uploadPack",
  "/:owner/:repo/git-upload-pack",
  { middleware: [Authenticated] },
) {}

/** `POST /:owner/:repo/git-receive-pack`: push. */
export class ReceivePack extends Http.post<ReceivePack>()(
  "receivePack",
  "/:owner/:repo/git-receive-pack",
  { middleware: [Authenticated] },
) {}

/**
 * The push pipeline's hashing endpoint (DESIGN §22.7), reached through the
 * Worker's self service binding and authenticated with the deploy-time
 * internal secret, never a user credential. No middleware.
 */
export class HashPart extends Http.post<HashPart>()("hashPart", HASH_ROUTE) {}

/** The git wire protocol, mounted at the root. */
export class Protocol extends HttpApiGroup.make("protocol", {
  topLevel: true,
}).add(InfoRefs, UploadPack, ReceivePack, HashPart) {}
