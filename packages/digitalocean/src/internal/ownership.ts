import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { sha256 } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";

const OWNERSHIP_TAG_PREFIX = "alchemy:";
const GENERATION_TAG_PREFIX = `${OWNERSHIP_TAG_PREFIX}generation:`;

/**
 * Names the logical resource; every generation of it carries this tag.
 * DigitalOcean tags are flat strings, so the stack, stage and name are
 * hashed into one.
 */
export const hashOwnershipTag = (stack: string, stage: string, fqn: string) =>
  Effect.map(sha256(`${stack}\0${stage}\0${fqn}`), (digest) => OWNERSHIP_TAG_PREFIX + digest);

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
