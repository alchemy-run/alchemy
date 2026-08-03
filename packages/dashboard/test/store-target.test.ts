/**
 * Stage names are per-stack, so the remembered-stage set must never
 * outlive a stack switch — otherwise the stage picker offers stages that
 * belong to a different stack and selecting one 404s.
 */
import { beforeEach, expect, test } from "bun:test";
import { dashboardStore, resetForTarget } from "../src/store.ts";

const seed = (stack: string, stagesSeen: string[]): void => {
  const state = dashboardStore.getState();
  dashboardStore.setState({
    document: { ...state.document, meta: { ...state.document.meta, stack } },
    layout: { ...state.layout, stagesSeen },
  });
};

beforeEach(() => {
  seed("alpha", ["prod", "dev_alpha"]);
});

test("switching stacks drops the previous stack's remembered stages", () => {
  resetForTarget({ stack: "beta", stage: undefined });
  expect(dashboardStore.getState().layout.stagesSeen).toEqual([]);
});

test("switching stage within a stack keeps them", () => {
  resetForTarget({ stack: "alpha", stage: "dev_alpha" });
  expect(dashboardStore.getState().layout.stagesSeen).toEqual([
    "prod",
    "dev_alpha",
  ]);
});

test("an undefined stack means 'keep the current one', not a switch", () => {
  resetForTarget({ stack: undefined, stage: "prod" });
  expect(dashboardStore.getState().layout.stagesSeen).toEqual([
    "prod",
    "dev_alpha",
  ]);
});

test("the connection slice records the requested target verbatim", () => {
  resetForTarget({ stack: "beta", stage: "prod" });
  const { connection } = dashboardStore.getState();
  expect(connection.stack).toBe("beta");
  expect(connection.stage).toBe("prod");
  expect(connection.status).toBe("connecting");
});
