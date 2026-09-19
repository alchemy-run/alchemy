/** Development-only credentials for the local R2 S3 endpoint. Never use production credentials. */
export interface R2S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export const R2_S3_PATH = "/cdn-cgi/local/r2/s3/";

/**
 * Path-style S3 endpoint for a local Worker. Pass this as an S3 client's
 * `endpoint`, with `forcePathStyle: true` and `region: "auto"`.
 * Append the bucket name and object key when signing URLs directly.
 */
export const localS3Endpoint = (workerUrl: string | URL): string =>
  new URL(R2_S3_PATH, workerUrl).href;
