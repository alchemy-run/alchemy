import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
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
  public readonly stateStore: StateStore;
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
    this.stateStore = new (options.stateStore ?? FileSystemStateStore)(this);
  }

  public get chain(): string[] {
    if (this.parent) {
      return [...this.parent.chain, this.scopeName!];
    } else {
      return [this.stage];
    }
  }

  public enter() {
    scopeStorage.enterWith(this);
  }

  public async init() {
    await this.stateStore.init?.();
  }

  public fqn(resourceID: ResourceID): string {
    return [...this.chain, resourceID].join("/");
  }

  public getScopePath(root: string): string {
    // First, compute the parent's scope path
    const parentPath = this.parent ? this.parent.getScopePath(root) : root;
    // Then join the current scope name (if any) onto the parent's path
    return this.scopeName ? path.join(parentPath, this.scopeName) : parentPath;
  }

  public async finalize() {
    // TODO
  }

  [Symbol.asyncDispose]() {
    return this.finalize();
  }
}
