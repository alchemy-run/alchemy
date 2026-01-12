import { $ } from "alchemy-effect";
import * as Lambda from "alchemy-effect/aws/lambda";
import * as S3 from "alchemy-effect/aws/s3";
import * as Effect from "effect/Effect";
import { FilesBucket } from "./storage.ts";

/**
 * File API demonstrating S3 data plane operations:
 * - PUT /files/:key - Upload a file
 * - GET /files/:key - Download a file
 * - GET /files - List all files
 * - DELETE /files/:key - Delete a file
 * - POST /files/:key/copy - Copy a file
 * - POST /files/:key/multipart - Multipart upload demo
 */
export class FileApi extends Lambda.serve("FileApi", {
  fetch: Effect.fn(function* (event) {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    // Parse key from path like /files/my-file.txt
    const keyMatch = path.match(/^\/files\/(.+)/);
    const key = keyMatch?.[1];

    // PUT /files/:key - Upload a file
    if (method === "PUT" && key) {
      const body = event.body ?? "";
      const contentType =
        event.headers["content-type"] ?? "application/octet-stream";

      yield* S3.putObject(FilesBucket, {
        key,
        body,
        contentType,
      }).pipe(Effect.orDie);

      return {
        statusCode: 201,
        body: JSON.stringify({ message: "File uploaded", key }),
      };
    }

    // GET /files - List all files
    if (method === "GET" && path === "/files") {
      const prefix = event.queryStringParameters?.prefix;
      const maxKeysStr = event.queryStringParameters?.maxKeys;
      const continuationToken =
        event.queryStringParameters?.continuationToken;

      const result = yield* S3.listObjectsV2(FilesBucket, {
        prefix,
        maxKeys: maxKeysStr ? parseInt(maxKeysStr, 10) : undefined,
        continuationToken,
      }).pipe(Effect.orDie);

      return {
        statusCode: 200,
        body: JSON.stringify({
          files:
            result.Contents?.map((obj) => ({
              key: obj.Key,
              size: obj.Size,
              lastModified: obj.LastModified,
            })) ?? [],
          isTruncated: result.IsTruncated,
          nextContinuationToken: result.NextContinuationToken,
        }),
      };
    }

    // GET /files/:key - Get file metadata (but not /files/:key/copy or /files/:key/multipart)
    if (method === "GET" && key && !key.includes("/")) {
      // Use headObject to get file metadata
      const headResult = yield* S3.headObject(FilesBucket, { key }).pipe(
        Effect.map((r) => r as typeof r | null),
        Effect.catchAll(() => Effect.succeed(null)),
      );

      if (!headResult) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "File not found" }),
        };
      }

      // Return file metadata
      return {
        statusCode: 200,
        headers: {
          "content-type": headResult.ContentType ?? "application/octet-stream",
          "content-length": String(headResult.ContentLength ?? 0),
        },
        body: JSON.stringify({
          key,
          contentType: headResult.ContentType,
          contentLength: headResult.ContentLength,
          lastModified: headResult.LastModified,
          etag: headResult.ETag,
        }),
      };
    }

    // DELETE /files/:key - Delete a file
    if (method === "DELETE" && key) {
      yield* S3.deleteObject(FilesBucket, { key }).pipe(Effect.orDie);

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "File deleted", key }),
      };
    }

    // POST /files/:key/copy - Copy a file to a new location
    if (method === "POST" && key?.endsWith("/copy")) {
      const sourceKey = key.replace(/\/copy$/, "");
      const body = event.body ? JSON.parse(event.body) : {};
      const destinationKey = (body as { destinationKey?: string })
        .destinationKey;

      if (!destinationKey) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "destinationKey is required" }),
        };
      }

      // CopySource format: bucket-name/key
      yield* S3.copyObject(FilesBucket, {
        key: destinationKey,
        copySource: `${FilesBucket.attr.bucketName}/${sourceKey}`,
      }).pipe(Effect.orDie);

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "File copied",
          source: sourceKey,
          destination: destinationKey,
        }),
      };
    }

    // POST /files/:key/multipart - Demonstrate multipart upload
    if (method === "POST" && key?.endsWith("/multipart")) {
      const targetKey = key.replace(/\/multipart$/, "");
      const body = event.body ? JSON.parse(event.body) : {};
      const parts = (body as { parts?: string[] }).parts ?? [];

      if (parts.length === 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "parts array is required for multipart upload",
          }),
        };
      }

      // 1. Create multipart upload
      const createResult = yield* S3.createMultipartUpload(FilesBucket, {
        key: targetKey,
        contentType: "application/octet-stream",
      }).pipe(Effect.orDie);

      const uploadId = createResult.UploadId!;
      const completedParts: S3.CompletedPart[] = [];

      // 2. Upload each part
      for (let i = 0; i < parts.length; i++) {
        const partNumber = i + 1;
        const partData = parts[i];

        const uploadResult = yield* S3.uploadPart(FilesBucket, {
          key: targetKey,
          uploadId,
          partNumber,
          body: partData,
        }).pipe(Effect.orDie);

        completedParts.push({
          etag: uploadResult.ETag!,
          partNumber,
        });
      }

      // 3. Complete the multipart upload
      yield* S3.completeMultipartUpload(FilesBucket, {
        key: targetKey,
        uploadId,
        parts: completedParts,
      }).pipe(Effect.orDie);

      return {
        statusCode: 201,
        body: JSON.stringify({
          message: "Multipart upload completed",
          key: targetKey,
          partsUploaded: parts.length,
        }),
      };
    }

    // Default: 404
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Not found" }),
    };
  }),
})({
  main: import.meta.filename,
  bindings: $(
    // All S3 operations we use
    S3.PutObject(FilesBucket),
    S3.DeleteObject(FilesBucket),
    S3.ListObjectsV2(FilesBucket),
    S3.HeadObject(FilesBucket),
    S3.CopyObject(FilesBucket),
    S3.MultipartUpload(FilesBucket),
  ),
  memory: 256,
  timeout: 30,
}) {}

export default FileApi.handler.pipe(Lambda.toHandler);
