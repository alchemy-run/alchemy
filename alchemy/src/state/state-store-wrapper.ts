import type { State, StateStore } from "../state.ts";
import type { ITelemetryClient } from "../util/telemetry/client.ts";

async function callWithPerformance<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; elapsed: number }> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  return { result, elapsed };
}

//todo(michael): we should also handle serde here
export class StateStoreWrapper implements StateStore {
  private readonly stateStore: StateStore;
  private readonly telemetryClient: ITelemetryClient;
  private readonly stateStoreClass: string;

  constructor(stateStore: StateStore, telemetryClient: ITelemetryClient) {
    this.stateStore = stateStore;
    this.telemetryClient = telemetryClient;
    this.stateStoreClass = stateStore.constructor.name;
  }

  async init() {
    if (this.stateStore.init == null) {
      return;
    }
    const { elapsed } = await callWithPerformance(
      this.stateStore.init.bind(this.stateStore),
    );
    this.telemetryClient.record({
      event: "stateStore.init",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
    return;
  }
  async deinit() {
    if (this.stateStore.deinit == null) {
      return;
    }
    const { elapsed } = await callWithPerformance(
      this.stateStore.deinit.bind(this.stateStore),
    );
    this.telemetryClient.record({
      event: "stateStore.deinit",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
  }
  async list() {
    const { elapsed, result } = await callWithPerformance(
      this.stateStore.list.bind(this.stateStore),
    );
    this.telemetryClient.record({
      event: "stateStore.list",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
    return result;
  }
  async count() {
    const { elapsed, result } = await callWithPerformance(
      this.stateStore.count.bind(this.stateStore),
    );
    this.telemetryClient.record({
      event: "stateStore.count",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
    return result;
  }
  async get(key: string) {
    const { elapsed, result } = await callWithPerformance(() =>
      this.stateStore.get.bind(this.stateStore)(key),
    );
    this.telemetryClient.record({
      event: "stateStore.get",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
    return result;
  }
  async getBatch(ids: string[]) {
    const { elapsed, result } = await callWithPerformance(() =>
      this.stateStore.getBatch.bind(this.stateStore)(ids),
    );
    this.telemetryClient.record({
      event: "stateStore.getBatch",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
    return result;
  }
  async all() {
    const { elapsed, result } = await callWithPerformance(() =>
      this.stateStore.all.bind(this.stateStore)(),
    );
    this.telemetryClient.record({
      event: "stateStore.all",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
    return result;
  }
  async set(key: string, value: State) {
    const { elapsed } = await callWithPerformance(() =>
      this.stateStore.set.bind(this.stateStore)(key, value),
    );
    this.telemetryClient.record({
      event: "stateStore.set",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
  }
  async delete(key: string) {
    const { elapsed } = await callWithPerformance(() =>
      this.stateStore.delete.bind(this.stateStore)(key),
    );
    this.telemetryClient.record({
      event: "stateStore.delete",
      stateStoreClass: this.stateStoreClass,
      elapsed,
    });
  }
}
