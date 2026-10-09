import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { generationTagFor, hashOwnershipTag } from "@/DigitalOcean/ownership";

describe("ownership tags", { tags: ["unit", "provider:digitalocean", "local"] }, () => {
  it.effect("is stable and fits DigitalOcean's tag rules", () =>
    Effect.gen(function* () {
      const tag = yield* hashOwnershipTag("stack", "stage", "id");
      expect(tag).toEqual(yield* hashOwnershipTag("stack", "stage", "id"));
      expect(tag.startsWith("alchemy:")).toBe(true);
      expect(tag).toMatch(/^[a-zA-Z0-9:_-]+$/);
      expect(tag.length).toBeLessThanOrEqual(255);
    }),
  );

  it.effect("does not collide on names that differ only in punctuation", () =>
    Effect.gen(function* () {
      expect(yield* hashOwnershipTag("api.prod", "s", "id")).not.toEqual(
        yield* hashOwnershipTag("api-prod", "s", "id"),
      );
    }),
  );

  it.effect("does not collide when the tuple boundaries move", () =>
    Effect.gen(function* () {
      expect(yield* hashOwnershipTag("a:b", "c", "id")).not.toEqual(
        yield* hashOwnershipTag("a", "b:c", "id"),
      );
    }),
  );

  it.effect("tells a nested resource from a top-level one", () =>
    Effect.gen(function* () {
      expect(yield* hashOwnershipTag("stack", "stage", "Api/Host")).not.toEqual(
        yield* hashOwnershipTag("stack", "stage", "Host"),
      );
    }),
  );

  it("tells two generations of one resource apart", () => {
    expect(generationTagFor("a".repeat(32))).toMatch(/^alchemy:generation:a{32}$/);
    expect(generationTagFor("a".repeat(32))).not.toEqual(generationTagFor("b".repeat(32)));
  });
});
