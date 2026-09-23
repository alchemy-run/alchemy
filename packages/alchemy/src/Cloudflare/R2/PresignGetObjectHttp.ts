import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PresignGetObject,
  type PresignGetObjectRequest,
} from "./PresignGetObject.ts";
import { makePresignBinding, presignR2Url } from "./PresignHttp.ts";

/**
 * Implementation of {@link PresignGetObject} over R2's S3-compatible API.
 *
 * Deployed, it mints a scoped account API token with
 * `Workers R2 Storage Read` and signs URLs for
 * `{accountId}.r2.cloudflarestorage.com`. Under `alchemy dev`, a
 * locally-emulated bucket is signed for the Worker's local S3 endpoint.
 *
 * @layer
 * @provides Cloudflare.R2.PresignGetObject
 * @product R2
 */
export const PresignGetObjectHttp = Layer.effect(
  PresignGetObject,
  Effect.suspend(() =>
    makePresignBinding<PresignGetObjectRequest>({
      name: "Cloudflare.R2.PresignGetObject",
      permissionGroups: ["Workers R2 Storage Read"],
      presign: (target, request) =>
        presignR2Url(target, {
          method: "GET",
          key: request.key,
          expiresIn: request.expiresIn,
          query: {
            ...(request.contentType !== undefined
              ? { "response-content-type": request.contentType }
              : {}),
            ...(request.contentDisposition !== undefined
              ? { "response-content-disposition": request.contentDisposition }
              : {}),
          },
        }),
    }),
  ),
);
