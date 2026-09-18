/**
 * SCENARIO — the intake batcher's decision. Eleven events land inside
 * one window: the drained batch bursts (one walker run over all of
 * them); pushes ride along as today's single messages. A lone event
 * never bursts. The decision is pure code (`planBatch`); the DO
 * supplies only pend/claim atomicity, smoke-tested live.
 */
import { describe, expect, test } from "bun:test";
import {
  BURST_AT,
  planBatch,
  type Pended,
} from "../../src/engineering/Triage.ts";

const issue = (n: number, title: string): Pended => ({
  kind: "issue",
  text: `opened issue org/alchemy#${n} — ${title}`,
  ref: `org/alchemy#${n}`,
  repo: "org/alchemy",
  number: n,
  title,
});

const pull = (n: number, title: string): Pended => ({
  kind: "pull",
  text: `opened pull request org/alchemy#${n} — ${title}`,
  ref: `org/alchemy#${n}`,
  repo: "org/alchemy",
  number: n,
  title,
});

const push: Pended = {
  kind: "request",
  text: "pushed to `main` in org/alchemy — chore: bump",
};

describe("triage batcher", () => {
  test("eleven events burst; the push rides the single path", () => {
    const batch: Pended[] = [
      pull(2001, "fix(aws/s3): tags drift"),
      pull(2002, "fix(aws/ec2): attr sync"),
      pull(2003, "fix(aws/rds): storage params"),
      pull(2004, "fix(aws/lambda): url config"),
      pull(2005, "feat(aws/sqs): redrive"),
      pull(2010, "fix(fly): restart loop"),
      pull(2011, "fix(railway): volume race"),
      pull(2012, "fix(hetzner): rescue flag"),
      issue(3001, "OOM importing distilled"),
      issue(3010, "D1 uppercase BEGIN"),
      push,
    ];
    const plan = planBatch(batch);
    expect(plan.burst).toHaveLength(10);
    expect(plan.singles).toEqual([push]);
  });

  test("a lone event takes today's path unchanged", () => {
    const plan = planBatch([issue(3001, "OOM importing distilled")]);
    expect(plan.burst).toHaveLength(0);
    expect(plan.singles).toHaveLength(1);
  });

  test("two events still degrade to singles — a burst needs three", () => {
    const plan = planBatch([
      issue(3001, "OOM importing distilled"),
      issue(3002, "OOM during git import"),
    ]);
    expect(plan.burst).toHaveLength(0);
    expect(plan.singles).toHaveLength(2);
    expect(BURST_AT).toBe(3);
  });

  test("pushes alone never burst, however many", () => {
    const plan = planBatch([push, push, push, push]);
    expect(plan.burst).toHaveLength(0);
    expect(plan.singles).toHaveLength(4);
  });
});
