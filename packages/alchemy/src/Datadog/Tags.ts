import * as Effect from "effect/Effect";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";

const normalizeTagPart = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
};

const normalizeTag = (tag: string): string => tag.toLowerCase();

export const createDatadogOwnershipTags = Effect.fn(function* (id?: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return [
    `alchemy_stack:${normalizeTagPart(stack.name)}`,
    `alchemy_stage:${normalizeTagPart(stage)}`,
    ...(id === undefined ? [] : [`alchemy_id:${normalizeTagPart(id)}`]),
  ];
});

export const withDatadogOwnershipTags = Effect.fn(function* (
  id: string,
  tags: string[] | undefined,
) {
  const ownershipTags = yield* createDatadogOwnershipTags(id);
  return [...new Set([...(tags ?? []), ...ownershipTags])];
});

export const hasDatadogStackOwnershipTags = Effect.fn(function* (
  tags: string[] | undefined,
) {
  const expected = yield* createDatadogOwnershipTags();
  const actual = new Set((tags ?? []).map(normalizeTag));
  return expected.every((tag) => actual.has(tag));
});
