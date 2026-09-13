/**
 * The `protocol` group: git smart HTTP v0 at the repository's root path.
 * The routes are streaming binary (pkt-lines in, sideband packs out),
 * answer with the response they build, and declare no schemas.
 *
 * `:repo` may carry a `.git` suffix; the handlers strip it.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/** `GET /:owner/:repo/info/refs?service=…`: the ref advertisement. */
export const InfoRefs = HttpApiEndpoint.get(
  "infoRefs",
  "/:owner/:repo/info/refs",
  {},
);

/** `POST /:owner/:repo/git-upload-pack`: clone and fetch. */
export const UploadPack = HttpApiEndpoint.post(
  "uploadPack",
  "/:owner/:repo/git-upload-pack",
  {},
);

/** `POST /:owner/:repo/git-receive-pack`: push. */
export const ReceivePack = HttpApiEndpoint.post(
  "receivePack",
  "/:owner/:repo/git-receive-pack",
  {},
);

/** The git wire protocol, mounted at the root. */
export class Protocol extends HttpApiGroup.make("protocol", {
  topLevel: true,
}).add(InfoRefs, UploadPack, ReceivePack) {}
