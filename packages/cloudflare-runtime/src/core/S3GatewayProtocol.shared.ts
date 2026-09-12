/**
 * The tiny contract between the dev S3 gateway (`S3Gateway.ts`, runs in
 * the dev session's runtime process) and FUSE-mounting container guests
 * (alchemy's `FuseMountTigrisfs`, bundled INTO the container image).
 * Zero dependencies on purpose: the guest imports this module alone.
 */

/**
 * Marker env var a container binds (any value) to declare "I FUSE-mount
 * a local R2 bucket". The Docker create interceptor keys on its
 * presence: matching containers get the FUSE device + capability and
 * the {@link S3_GATEWAY_URL_ENV} injection; every other container is
 * untouched.
 */
export const R2_FUSE_MARKER_ENV = "ALCHEMY_R2_FUSE";

/**
 * Env var the Docker create interceptor injects into marked containers:
 * the S3 gateway's base URL as reachable FROM INSIDE the container
 * (`http://host.docker.internal:{port}`).
 */
export const S3_GATEWAY_URL_ENV = "ALCHEMY_S3_GATEWAY_URL";

const LOCAL_BUCKET_ALIAS_PREFIX = "local-";

/**
 * Encode a bucket name for use as an S3 path-style bucket segment and
 * as a `tigrisfs` bucket argument. Local bucket ids are `dev:<uuid>` —
 * and geesefs/tigrisfs split their bucket argument on the FIRST COLON
 * (`bucket:prefix`), so the raw id would silently mount bucket `dev`
 * with prefix `<uuid>`. Hex-encode local ids behind a recognizable
 * prefix; real bucket names pass through untouched.
 */
export const encodeS3BucketAlias = (bucketName: string): string =>
  bucketName.includes(":")
    ? `${LOCAL_BUCKET_ALIAS_PREFIX}${toHex(bucketName)}`
    : bucketName;

/**
 * Reverse {@link encodeS3BucketAlias}. Aliases are `local-<hex>`;
 * anything else is a verbatim bucket name.
 */
export const decodeS3BucketAlias = (alias: string): string => {
  if (!alias.startsWith(LOCAL_BUCKET_ALIAS_PREFIX)) return alias;
  const hex = alias.slice(LOCAL_BUCKET_ALIAS_PREFIX.length);
  return /^[0-9a-f]+$/.test(hex) && hex.length % 2 === 0 ? fromHex(hex) : alias;
};

// environment-neutral (no Buffer): this module is bundled into guests
const toHex = (value: string): string =>
  Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (hex: string): string =>
  new TextDecoder().decode(
    new Uint8Array(
      Array.from({ length: hex.length / 2 }, (_, i) =>
        Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
      ),
    ),
  );
