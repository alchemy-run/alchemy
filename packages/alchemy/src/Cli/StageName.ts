import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";
import { base32 } from "../Util/base32.ts";

const MAX_STAGE_LENGTH = 63;
const HASH_LENGTH = 8;
const prefix = "dev-";
const safeUserPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const StageName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+([-_a-z0-9]+)*$/i),
);

export const defaultStageName = Effect.fn(function* (user: string | undefined) {
  if (user === undefined || user === "") {
    return yield* Effect.fail(new CliError.MissingOption({ option: "stage" }));
  }

  const maxUserLength = MAX_STAGE_LENGTH - prefix.length;
  if (user.length <= maxUserLength && safeUserPattern.test(user)) {
    return `${prefix}${user}`;
  }

  const hash = yield* Effect.sync(() =>
    base32(createHash("sha256").update(user).digest()).slice(0, HASH_LENGTH),
  );
  const slug =
    user
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user";
  const maxSlugLength = maxUserLength - HASH_LENGTH - 1;
  const truncated = slug.slice(0, maxSlugLength).replace(/-+$/g, "");
  return `${prefix}${truncated}-${hash}`;
});
