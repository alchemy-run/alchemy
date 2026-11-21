import { createHash } from "node:crypto";

const MAX_REFERENCE_LENGTH = 100;
const PREVIEW_PREFIX = "preview/";

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

/**
 * The value to send as `reference` when creating a preview. Convex treats it as
 * an identifier and stores {@link previewReference}. A long stage gets a hash,
 * because Convex cuts references at 100 characters and two previews with one
 * reference would replace each other.
 */
export const previewIdentifier = (stage: string) => {
  const slug = stage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return shortHash(stage);
  const limit = MAX_REFERENCE_LENGTH - PREVIEW_PREFIX.length;
  return slug.length <= limit ? slug : `${slug.slice(0, limit - 9)}-${shortHash(stage)}`;
};

/** The reference Convex stores for a stage's preview, used to look it up. */
export const previewReference = (stage: string) => `${PREVIEW_PREFIX}${previewIdentifier(stage)}`;
