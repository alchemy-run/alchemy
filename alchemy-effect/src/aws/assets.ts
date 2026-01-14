import type { HttpClient } from "@effect/platform/HttpClient";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Credentials } from "distilled-aws/Credentials";
import type { Region } from "distilled-aws/Region";

/**
 * Error type for Assets service operations.
 */
export type AssetsError =
  | {
      readonly _tag: "AssetsUploadError";
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly _tag: "AssetsCheckError";
      readonly message: string;
      readonly cause?: unknown;
    };

/**
 * Requirements for Assets operations (S3 operations need these).
 */
export type AssetsRequirements = Region | Credentials | HttpClient;

export class Assets extends Context.Tag("AWS::Assets")<
  Assets,
  {
    /**
     * The name of the assets bucket.
     */
    readonly bucketName: string;

    /**
     * Upload an asset to the assets bucket.
     * Uses content-addressed storage: `lambda/{hash}.zip`
     *
     * @param hash - The content hash of the asset
     * @param content - The asset content (zip file)
     * @returns The S3 key where the asset was uploaded
     */
    readonly uploadAsset: (
      hash: string,
      content: Uint8Array,
    ) => Effect.Effect<string, AssetsError, AssetsRequirements>;

    /**
     * Check if an asset already exists in the assets bucket.
     *
     * @param hash - The content hash to check
     * @returns true if the asset exists
     */
    readonly hasAsset: (
      hash: string,
    ) => Effect.Effect<boolean, AssetsError, AssetsRequirements>;
  }
>() {}
