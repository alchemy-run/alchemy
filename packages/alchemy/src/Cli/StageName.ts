import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { base32 } from "../Util/base32.ts";

const MAX_DEFAULT_STAGE_LENGTH = 32;
const HASH_LENGTH = 6;
const prefix = "dev-";
const defaultUserPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const StageNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+([-_a-z0-9]+)*$/i),
);

export const createDefaultStageName = Effect.fn(function* (user: string) {
  const maxUserLength = MAX_DEFAULT_STAGE_LENGTH - prefix.length;
  if (user.length <= maxUserLength && defaultUserPattern.test(user)) {
    return `${prefix}${user}`;
  }

  const hash = yield* Effect.sync(() =>
    base32(createHash("sha256").update(user).digest()).slice(0, HASH_LENGTH),
  );
  const slug = user
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    return `${prefix}${hash}`;
  }
  const maxSlugLength = maxUserLength - HASH_LENGTH - 1;
  const truncated = slug.slice(0, maxSlugLength).replace(/-+$/g, "");
  return `${prefix}${truncated}-${hash}`;
});
