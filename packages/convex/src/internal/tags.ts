import { createHash } from "node:crypto";

/**
 * The tag that marks a project as created by this resource. Convex limits a tag
 * to 32 letters, numbers, `-` and `_`, so the stack, stage and logical ID are
 * hashed rather than spelled out.
 */
export const ownershipTag = (stack: string, stage: string, id: string) =>
  `alchemy-${createHash("sha256")
    .update(JSON.stringify([stack, stage, id]))
    .digest("hex")
    .slice(0, 24)}`;

/** Whether a tag is one {@link ownershipTag} produced. */
export const isOwnershipTag = (tag: string) => /^alchemy-[0-9a-f]{24}$/.test(tag);
