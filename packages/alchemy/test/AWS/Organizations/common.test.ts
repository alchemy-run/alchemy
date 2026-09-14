import { describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

const tags: Record<string, string> = { managed_by: "alchemy" };
const writes: Array<{ Key: string; Value: string }> = [];

mock.module("@distilled.cloud/aws/organizations", () => ({
  tagResource: ({ Tags }: { Tags: Array<{ Key: string; Value: string }> }) =>
    Effect.sync(() => {
      writes.push(...Tags);
      for (const { Key, Value } of Tags) tags[Key] = Value;
    }),
  untagResource: ({ TagKeys }: { TagKeys: Array<string> }) =>
    Effect.sync(() => {
      for (const key of TagKeys) delete tags[key];
    }),
}));

const { updateResourceTags } = await import("@/AWS/Organizations/common");
const { Stack } = await import("@/Stack");
const { Stage } = await import("@/Stage");

const run = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Stack, { name: "tag-test" } as any),
      Effect.provideService(Stage, "test"),
    ) as Effect.Effect<A, unknown, never>,
  );

describe("Organizations tag reconciliation", () => {
  test("writes missing ownership tags and converges on the next read", async () => {
    const desired = { managed_by: "alchemy" };

    const returned = await run(
      updateResourceTags({
        id: "resource-id",
        resourceId: "r-example",
        olds: { ...tags },
        news: desired,
      }),
    );

    expect(writes).toEqual([
      { Key: "alchemy::stack", Value: "tag-test" },
      { Key: "alchemy::stage", Value: "test" },
      { Key: "alchemy::id", Value: "resource-id" },
    ]);
    expect(returned as Record<string, string>).toEqual(tags);

    writes.length = 0;
    await run(
      updateResourceTags({
        id: "resource-id",
        resourceId: "r-example",
        olds: { ...tags },
        news: desired,
      }),
    );

    expect(writes).toEqual([]);
  });
});
