/**
 * Which objects a Domain host entity on Effect Cluster treats as superseded:
 * an earlier generation of a view's or projection's keys or run, when this
 * code hosts a later one. Their wakes are taken and dropped, so a version
 * bump leaves no wake retrying against a class nothing hosts.
 */
import { className, consumerClass, runClass } from "@alchemy.run/domain/DurableObjects";
import { supersededBy } from "@alchemy.run/domain/EffectCluster";
import { describe, expect, it } from "@alchemy.run/test";

const keys = (kind: "view" | "projection", name: string, generation: number) =>
  className("Bank", consumerClass(kind, name, generation));
const run = (kind: "view" | "projection", name: string, generation: number) =>
  className("Bank", runClass(consumerClass(kind, name, generation)));

describe("Domain on Effect Cluster: superseded generations", { tags: ["unit"] }, () => {
  it("an earlier generation's run is superseded by the hosted one", () => {
    const hosted = [run("view", "Deposits", 2), keys("view", "Deposits", 2)];
    expect(supersededBy(run("view", "Deposits", 1), hosted)).toBe(run("view", "Deposits", 2));
    expect(supersededBy(run("view", "Deposits", 0), hosted)).toBe(run("view", "Deposits", 2));
  });

  it("an earlier generation's keys are superseded by the hosted keys, not by the run", () => {
    expect(supersededBy(keys("projection", "Ledger", 0), [keys("projection", "Ledger", 1)])).toBe(
      keys("projection", "Ledger", 1),
    );
    expect(
      supersededBy(keys("projection", "Ledger", 0), [run("projection", "Ledger", 1)]),
    ).toBeUndefined();
  });

  it("a consumer whose own name ends in its kind is told apart by generation", () => {
    const hosted = [run("projection", "SignalGraphProjection", 5)];
    expect(supersededBy(run("projection", "SignalGraphProjection", 4), hosted)).toBe(hosted[0]);
  });

  it("a later generation is not superseded: a runner on older code leaves it to newer runners", () => {
    expect(supersededBy(run("view", "Deposits", 3), [run("view", "Deposits", 2)])).toBeUndefined();
  });

  it("other classes, models and consumers are never superseded", () => {
    const hosted = [run("view", "Deposits", 2), className("Bank", "AccountAggregate")];
    expect(supersededBy(className("Bank", "AccountAggregate"), hosted)).toBeUndefined();
    expect(supersededBy(className("Bank", "WelcomePolicy"), hosted)).toBeUndefined();
    expect(supersededBy(run("view", "Withdrawals", 1), hosted)).toBeUndefined();
    expect(
      supersededBy(className("Other", runClass(consumerClass("view", "Deposits", 1))), hosted),
    ).toBeUndefined();
  });
});
