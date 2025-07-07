import type { Scope } from "../scope.ts";
import type { State, StateStore } from "../state.ts";

export class DefaultStateStore implements StateStore {
  readonly _tag =
    process.env.ALCHEMY_STATE_STORE === "cloudflare-d1"
      ? "SQLiteStateStore"
      : "DefaultStateStore";
  private instance: Promise<StateStore>;

  constructor(scope: Scope) {
    this.instance = importStateStore(scope);
  }

  init?(): Promise<void> {
    return this.instance.then((it) => it.init?.());
  }
  deinit?(): Promise<void> {
    return this.instance.then((it) => it.deinit?.());
  }
  list(): Promise<string[]> {
    return this.instance.then((it) => it.list());
  }
  count(): Promise<number> {
    return this.instance.then((it) => it.count());
  }
  get(key: string): Promise<State | undefined> {
    return this.instance.then((it) => it.get(key));
  }
  getBatch(ids: string[]): Promise<Record<string, State>> {
    return this.instance.then((it) => it.getBatch(ids));
  }
  all(): Promise<Record<string, State>> {
    return this.instance.then((it) => it.all());
  }
  set(key: string, value: State): Promise<void> {
    return this.instance.then((it) => it.set(key, value));
  }
  delete(key: string): Promise<void> {
    return this.instance.then((it) => it.delete(key));
  }
}

const importStateStore = (scope: Scope): Promise<StateStore> => {
  switch (process.env.ALCHEMY_STATE_STORE) {
    case "cloudflare-d1":
      return import("./d1.ts").then((it: any) => new it.D1StateStore(scope));
    case "cloudflare":
      return import("../cloudflare/index.ts").then(
        (it) => new it.DOStateStore(scope),
      );
    default:
      return import("../fs/file-system-state-store.ts").then(
        (it) => new it.FileSystemStateStore(scope),
      );
  }
};
