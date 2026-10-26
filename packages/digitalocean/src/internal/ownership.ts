import { createHash } from "node:crypto";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

const OWNERSHIP_TAG_PREFIX = "alchemy:";
const GENERATION_TAG_PREFIX = `${OWNERSHIP_TAG_PREFIX}generation:`;

const sha256Hex = (input: string) =>
  Effect.sync(() => createHash("sha256").update(input).digest("hex"));

/**
 * Names the logical resource. Every generation of it carries this tag, so
 * a resource whose state was lost is found again. DigitalOcean tags are
 * flat strings, so the stack, stage and name are hashed into one.
 */
export const hashOwnershipTag = (stack: string, stage: string, fqn: string) =>
  Effect.map(sha256Hex(`${stack}\0${stage}\0${fqn}`), (digest) => OWNERSHIP_TAG_PREFIX + digest);

export const ownershipTagFor = Effect.fn(function* (fqn: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return yield* hashOwnershipTag(stack.name, stage, fqn);
});

/**
 * Names one generation. A replacement and the resource it replaces share
 * the ownership tag, so only this tag tells them apart.
 */
export const generationTagFor = (instanceId: string) => GENERATION_TAG_PREFIX + instanceId;

export const isAlchemyTag = (tag: string) => tag.startsWith(OWNERSHIP_TAG_PREFIX);

export const withoutAlchemyTags = (tags: ReadonlyArray<string>) =>
  tags.filter((tag) => !isAlchemyTag(tag));
