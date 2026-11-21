import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Thread } from "../src/Thread/Thread.aggregate.ts";

describe("Board rules", () => {
  // Thirteen commands: every sequence of two of them, each with every input the solver finds.
  it.effect(
    "a thread keeps its rules",
    () => Verify.aggregate(Thread, { depth: 2 }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );
});
