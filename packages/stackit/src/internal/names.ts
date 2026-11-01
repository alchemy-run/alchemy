/**
 * Ownership fallback for STACKIT APIs that have no labels (Object Storage
 * buckets and credentials groups, affinity groups, service accounts, ...).
 *
 * Core `createPhysicalName` ends every generated name with the resource's
 * instance id in lowercase base32 (`a-z2-7`), in one of two shapes:
 *
 * - `<stack>-<id>-<stage>-<16 chars>` when the name fits `maxLength`;
 * - `<truncated prefix><8-char hash><16 chars>` otherwise, exactly
 *   `maxLength` long, with a 24-character tail and no delimiter.
 *
 * `list` (used by `alchemy unsafe nuke`) enumerates names of those shapes
 * without an ownership label. To keep human-chosen names out, the name must
 * have the full shape (hyphen count, or exact length), and the tail must
 * contain at least one of base32's digits (`2-7`). About 3.6% of generated
 * 16-char tails have no digit and are skipped: nuke under-reports rather
 * than deleting a resource it did not create.
 *
 * This is a shape match, not proof of ownership: a hand-chosen name of the
 * same shape, such as `acme-prod-eu-a2b3c4d5e6f7g2h3`, is enumerated too.
 * Choose names outside the shape when a resource must survive a nuke.
 */
const SHORT_TAIL = /-([a-z2-7]{16})$/;
const TRUNCATED_TAIL = /([a-z2-7]{24})$/;
const HAS_DIGIT = /[2-7]/;

/** `stack-id-stage-` puts at least three hyphens before the instance suffix. */
const MIN_GENERATED_HYPHENS = 3;

/**
 * Whether `name` has the shape of a name `createPhysicalName` generates with
 * the default prefix and this `maxLength` (lowercase, as every caller here
 * generates).
 */
export const isGeneratedPhysicalName = (name: string, maxLength: number): boolean => {
  if (name.length > maxLength) return false;
  const short = SHORT_TAIL.exec(name)?.[1];
  if (
    short !== undefined &&
    HAS_DIGIT.test(short) &&
    name.split("-").length - 1 >= MIN_GENERATED_HYPHENS
  ) {
    return true;
  }
  const truncated = name.length === maxLength ? TRUNCATED_TAIL.exec(name)?.[1] : undefined;
  return truncated !== undefined && HAS_DIGIT.test(truncated);
};

/** `<1-3 char prefix>-<16 chars>`: the generated service account name, which has its own prefix. */
const SERVICE_ACCOUNT_NAME = /^[a-z][a-z0-9-]{0,2}-([a-z2-7]{16})$/;

/** Whether `name` has the shape of a generated service account name. */
export const isGeneratedServiceAccountName = (name: string): boolean => {
  const tail = SERVICE_ACCOUNT_NAME.exec(name)?.[1];
  return tail !== undefined && HAS_DIGIT.test(tail);
};
