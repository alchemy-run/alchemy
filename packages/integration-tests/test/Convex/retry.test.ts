import * as Convex from "@alchemy.run/convex";
import { createPolicy } from "@alchemy.run/convex/internal/retry";
import { ownershipTag } from "@alchemy.run/convex/internal/tags";
import { expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { InternalServerError, TooManyRequests } from "@distilled.cloud/convex/Errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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

const { test } = Test.make({ providers: Convex.providers() });

test.provider("every create runs through createOnce", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const src = path.join(import.meta.dirname, "../../../convex/src");
    const files = (yield* fs.readDirectory(src)).filter((file) => file.endsWith(".ts"));
    const raw: string[] = [];
    let total = 0;
    for (const file of files) {
      const source = yield* fs.readFileString(path.join(src, file));
      const calls = source.match(/\b(management|deployment)\s*\.create\w+\(/g) ?? [];
      const wrapped = source.match(/createOnce\(\s*(management|deployment)\s*\.create\w+\(/g) ?? [];
      total += calls.length;
      if (calls.length !== wrapped.length) raw.push(`${file}: ${calls.length - wrapped.length}`);
    }
    expect(raw).toEqual([]);
    // Project, Deployment, DeployKey, PreviewDeployKey, CustomDomain, LogStream, UsageLimit.
    expect(total).toBe(7);
  }),
);
