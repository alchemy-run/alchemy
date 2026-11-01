import { createPolicy } from "@alchemy.run/convex/internal/retry";
import { ownershipTag } from "@alchemy.run/convex/internal/tags";
import { expect, it } from "@alchemy.run/test";
import { InternalServerError, TooManyRequests } from "@distilled.cloud/convex/Errors";
import * as Effect from "effect/Effect";

it.effect("a create never repeats after a server error", () =>
  Effect.sync(() => {
    expect(createPolicy.while(new InternalServerError({ message: "boom" }))).toBe(false);
  }),
);

it.effect("a create retries when throttled", () =>
  Effect.sync(() => {
    expect(createPolicy.while(new TooManyRequests({ message: "slow" }))).toBe(true);
  }),
);

it.effect("create retries are bounded", () =>
  Effect.sync(() => {
    expect(createPolicy.backoff.maxRetries).toBeLessThanOrEqual(8);
  }),
);

it.effect("ownershipTag fits Convex's limit and allowed characters", () =>
  Effect.sync(() => {
    const tag = ownershipTag("a-very-long-stack-name-for-convex", "test_chris", "App/1:x");
    expect(tag.length).toBeLessThanOrEqual(32);
    expect(tag).toMatch(/^alchemy-[A-Za-z0-9_-]+$/);
  }),
);

it.effect("ownershipTag is stable and differs by stack, stage and id", () =>
  Effect.sync(() => {
    expect(ownershipTag("app", "dev", "Project")).toBe(ownershipTag("app", "dev", "Project"));
    const tags = new Set([
      ownershipTag("app", "dev", "Project"),
      ownershipTag("app2", "dev", "Project"),
      ownershipTag("app", "prod", "Project"),
      ownershipTag("app", "dev", "Other"),
    ]);
    expect(tags.size).toBe(4);
  }),
);
