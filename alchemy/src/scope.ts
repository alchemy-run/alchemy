import { AsyncLocalStorage } from "node:async_hooks";
import type { PendingResource, ResourceID } from "./resource";
import {
  FileSystemStateStore,
  type StateStore,
  type StateStoreType,
} from "./state";

const scopeStorage = new AsyncLocalStorage<Scope>();

export type ScopeOptions = {
  stage: string;
  parent?: Scope;
  scopeName?: string;
  password?: string;
  stateStore?: StateStoreType;
  quiet?: boolean;
};

export class Scope {
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
  public readonly stage: string;
  public readonly scopeName: string | null;
  public readonly parent: Scope | undefined;
  public readonly password: string | undefined;
  public readonly state: StateStore;
  public readonly quiet: boolean;

  constructor(options: ScopeOptions) {
    this.stage = options.stage;
    this.scopeName = options.scopeName ?? null;
    this.parent = options.parent;
    this.quiet = options.quiet ?? false;
    if (this.parent && !this.scopeName) {
      throw new Error("Scope name is required when creating a child scope");
    }
    this.password = options.password;
    this.state = new (options.stateStore ?? FileSystemStateStore)(this);
  }

  private _seq = 0;

  public seq() {
    return this._seq++;
  }

  public get chain(): string[] {
    if (this.parent) {
      return [...this.parent.chain, this.scopeName!];
    } else {
      return [this.stage, this.scopeName!];
    }
  }

  public enter() {
    scopeStorage.enterWith(this);
  }

  public async init() {
    await this.state.init?.();
  }

  public async deinit() {
    await this.state.deinit?.();
  }

  public fqn(resourceID: ResourceID): string {
    return [...this.chain, resourceID].join("/");
  }

  public async finalize() {
    // TODO
  }

  [Symbol.asyncDispose]() {
    return this.finalize();
  }
}
