import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePresignBinding, presignR2Url } from "./PresignHttp.ts";
import {
  PresignPutObject,
  type PresignPutObjectRequest,
} from "./PresignPutObject.ts";

/**
 * Implementation of {@link PresignPutObject} over R2's S3-compatible API.
 *
 * Deployed, it mints a scoped account API token with
 * `Workers R2 Storage Write` and signs URLs for
 * `{accountId}.r2.cloudflarestorage.com`. Under `alchemy dev`, a
 * locally-emulated bucket is signed for the Worker's local S3 endpoint.
 *
 * @layer
 * @provides Cloudflare.R2.PresignPutObject
 * @product R2
 */
export const PresignPutObjectHttp = Layer.effect(
  PresignPutObject,
  Effect.suspend(() =>
    makePresignBinding<PresignPutObjectRequest>({
      name: "Cloudflare.R2.PresignPutObject",
      permissionGroups: ["Workers R2 Storage Write"],
      presign: (target, request) =>
        presignR2Url(target, {
          method: "PUT",
          key: request.key,
          expiresIn: request.expiresIn,
          headers:
            request.contentType !== undefined
              ? { "content-type": request.contentType }
              : undefined,
        }),
    }),
  ),
);
