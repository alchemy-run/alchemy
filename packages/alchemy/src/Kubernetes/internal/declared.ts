import { deepEqual } from "../../Diff.ts";
import { isPlainObject } from "../../Util/data.ts";

const volatileMetadata = new Set([
  "uid",
  "resourceVersion",
  "generation",
  "creationTimestamp",
  "deletionTimestamp",
  "deletionGracePeriodSeconds",
  "managedFields",
  "selfLink",
]);

const withoutVolatileMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!volatileMetadata.has(key)) out[key] = value;
  }
  return out;
};

/**
 * `stringData` is write-only. The apiserver stores it as base64 `data` and
 * omits `stringData` from GET and dry-run responses, so compare the declared
 * strings with `data` decoded on both sides.
 */
const decodeSecretData = (data: unknown): Record<string, unknown> => {
  if (!isPlainObject(data)) return {};
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    decoded[key] =
      typeof value === "string"
        ? Buffer.from(value, "base64").toString("utf8")
        : value;
  }
  return decoded;
};

/**
 * Project an applied object onto the declared manifest. The dry-run is the
 * canonical applied form (defaults and list merge stay on the apiserver);
 * keys the manifest does not declare — admission annotations, controller
 * status — are not drift. Volatile fields are dropped only from the root
 * object's metadata, never from a nested field that happens to be named
 * `metadata`.
 *
 * ponytail: arrays align by declared index. Match on strategic-merge keys
 * if a webhook reorders list items and that shows up as false drift.
 */
const projectDeclared = (
  applied: unknown,
  desired: unknown,
  root: boolean,
): unknown => {
  if (Array.isArray(desired)) {
    const items = Array.isArray(applied) ? applied : [];
    return desired.map((item, index) =>
      projectDeclared(items[index], item, false),
    );
  }
  if (!isPlainObject(desired)) return applied;
  const source = isPlainObject(applied) ? applied : {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(desired)) {
    const value =
      root && key === "metadata" && isPlainObject(source[key])
        ? withoutVolatileMetadata(source[key])
        : root &&
            key === "stringData" &&
            (source.kind === "Secret" || desired.kind === "Secret")
          ? decodeSecretData(source.data)
          : source[key];
    out[key] = projectDeclared(value, child, false);
  }
  return out;
};

/** True when a live object and a dry-run preview agree on declared fields. */
export const appliedObjectsMatch = (
  live: unknown,
  preview: unknown,
  desired: unknown,
): boolean =>
  deepEqual(
    projectDeclared(live, desired, true),
    projectDeclared(preview, desired, true),
  );
