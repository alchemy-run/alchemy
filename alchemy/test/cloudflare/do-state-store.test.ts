import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { DOFSStateStore } from "../../src/cloudflare/do-state-store/index.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

// must import this or else alchemy.test won't exist
import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("DOFS State Store", () => {
  test("create and configure state store", async (scope) => {
    const stateStore = new DOFSStateStore(scope, {
      autoDeploy: false,
      url: "https://test-worker.example.workers.dev",
      workerName: `${BRANCH_PREFIX}-test-worker`,
      basePath: "/test-alchemy",
    });

    expect(stateStore.scope).toBe(scope);
    
    await destroy(scope);
  });

  test("auto-deploy worker with bundling", async (scope) => {
    const stateStore = new DOFSStateStore(scope, {
      autoDeploy: true,
      workerName: `${BRANCH_PREFIX}-dofs-test-worker-v3`,
      basePath: "/test-alchemy",
    });

    // This should create and deploy a worker successfully
    await stateStore.init();
    
    await destroy(scope);
  });

  test("state operations", async (scope) => {
    const stateStore = new DOFSStateStore(scope, {
      autoDeploy: true,
      workerName: `${BRANCH_PREFIX}-ops-test-worker-v4`,
    });

    // Test basic operations with actual deployment
    const keys = await stateStore.list();
    expect(Array.isArray(keys)).toBe(true);

    const count = await stateStore.count();
    expect(typeof count).toBe('number');

    const allStates = await stateStore.all();
    expect(typeof allStates).toBe('object');

    await destroy(scope);
  });
}); 