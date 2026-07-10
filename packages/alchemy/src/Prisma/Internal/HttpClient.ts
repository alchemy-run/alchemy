import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";

/** Node transport preserves explicit Content-Length on file-backed uploads. */
export const PrismaHttpClientLive = NodeHttpClient.layerNodeHttp;
