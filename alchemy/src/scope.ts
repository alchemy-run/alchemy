import { AsyncLocalStorage } from "node:async_hooks";
import type { Phase } from "./alchemy.js";
import { destroy } from "./destroy.js";
import { FileSystemStateStore } from "./fs/file-system-state-store.js";
import { ResourceID, type PendingResource } from "./resource.js";
import type { StateStore, StateStoreType } from "./state.js";

const scopeStorage = new AsyncLocalStorage<Scope>();

export type ScopeOptions = {
  appName?: string;
  stage?: string;
  parent?: Scope;
  scopeName?: string;
  password?: string;
  stateStore?: StateStoreType;
  quiet?: boolean;
  phase?: Phase;
};

// TODO: support browser
const DEFAULT_STAGE = process.env.ALCHEMY_STAGE ?? process.env.USER ?? "dev";

export class Scope {
  public static readonly KIND = "alchemy::Scope" as const;

  public static get(): Scope | undefined {
    return scopeStorage.getStore();
  }

  public static get current(): Scope {
    const scope = Scope.get();
    if (!scope) {
      throw new Error("Not running within an Alchemy Scope");
    }
    return scope;
  }

  public readonly resources = new Map<ResourceID, PendingResource>();
  public readonly appName: string | undefined;
  public readonly stage: string;
  public readonly scopeName: string | null;
  public readonly parent: Scope | undefined;
  public readonly password: string | undefined;
  public readonly state: StateStore;
  public readonly stateStore: StateStoreType;
  public readonly quiet: boolean;
  public readonly phase: Phase;

  private isErrored = false;

  constructor(options: ScopeOptions) {
    this.appName = options.appName;
    this.stage = options?.stage ?? DEFAULT_STAGE;
    this.scopeName = options.scopeName ?? null;
    if (this.scopeName?.includes(":")) {
      throw new Error(
        `Scope name ${this.scopeName} cannot contain double colons`,
      );
    }
    this.parent = options.parent ?? Scope.get();
    this.quiet = options.quiet ?? this.parent?.quiet ?? false;
    if (this.parent && !this.scopeName) {
      throw new Error("Scope name is required when creating a child scope");
    }
    this.password = options.password ?? this.parent?.password;
    const phase = options.phase ?? this.parent?.phase;
    if (phase === undefined) {
      throw new Error("Phase is required");
    }
    this.phase = phase;

    this.stateStore =
      options.stateStore ??
      this.parent?.stateStore ??
      ((scope) => new FileSystemStateStore(scope));
    this.state = this.stateStore(this);
  }

  public async delete(resourceID: ResourceID) {
    await this.state.delete(resourceID);
    this.resources.delete(resourceID);
  }

  private _seq = 0;

  public seq() {
    return this._seq++;
  }

  public get chain(): string[] {
    const thisScope = this.scopeName ? [this.scopeName] : [];
    const app = this.appName ? [this.appName] : [];
    if (this.parent) {
      return [...this.parent.chain, ...thisScope];
    }
    return [...app, this.stage, ...thisScope];
  }

  public fail() {
    console.error("Scope failed", this.chain.join("/"));
    this.isErrored = true;
  }

  public enter() {
    scopeStorage.enterWith(this);
  }

  public async init() {
    await this.state.init?.();
  }

  public async deinit() {
    await this.parent?.state.delete(this.scopeName!);
    await this.state.deinit?.();
  }

  public fqn(resourceID: ResourceID): string {
    return [...this.chain, resourceID].join("/");
  }

  public async run<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
    return scopeStorage.run(this, () => fn(this));
  }

  [Symbol.asyncDispose]() {
    return this.finalize();
  }

  public async finalize() {
    if (this.phase === "read") {
      return;
    }
    if (!this.isErrored) {
      // TODO: need to detect if it is in error
      const resourceIds = await this.state.list();
      const aliveIds = new Set(this.resources.keys());
      const orphanIds = Array.from(
        resourceIds.filter((id) => !aliveIds.has(id)),
      );
      const orphans = await Promise.all(
        orphanIds.map(async (id) => (await this.state.get(id))!.output),
      );
      await destroy.all(orphans, {
        quiet: this.quiet,
        strategy: "sequential",
      });
    } else {
      console.warn("Scope is in error, skipping finalize");
    }
  }

  /**
   * Returns a string representation of the scope.
   */
  public toString() {
    return `Scope(
  chain=${this.chain.join("/")},
  resources=[${Array.from(this.resources.values())
    .map((r) => r[ResourceID])
    .join(",\n  ")}]
)`;
  }
}
