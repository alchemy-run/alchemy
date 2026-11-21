import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { inProjectCwd } from "../DevChild.ts";
import { makeProject, run } from "./helpers.ts";

it("accepts a root that reaches the working directory through a symlink", async () => {
  const dir = await makeProject({});
  const link = NodePath.join(dir, "cwd-link");
  await NodeFsPromises.symlink(process.cwd(), link, "dir");
  await expect(run(inProjectCwd("test", link, Effect.succeed("ran")))).resolves.toBe("ran");
});

it("fails outside the project root", async () => {
  const dir = await makeProject({});
  await expect(run(inProjectCwd("test", dir, Effect.succeed("ran")))).rejects.toThrow(
    /must run with its project root/,
  );
});
