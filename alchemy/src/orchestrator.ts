import net from "node:net";
import { alchemy } from "./alchemy.ts";
import { context } from "./context.ts";
import type { Provider, ResourceFQN } from "./resource.ts";
import {
  PROVIDERS,
  ResourceKind,
  ResourceSeq,
  type PendingResource,
} from "./resource.ts";
import type { Scope } from "./scope.ts";
import { formatFQN } from "./util/cli.ts";
import { logger } from "./util/logger.ts";

export type Port = number;

export interface Orchestrator {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  listResources(isRunning?: boolean): Promise<
    Array<{
      fqn: ResourceFQN;
      isRunning: boolean;
      port?: Port;
    }>
  >;
  getResource(resourceFQN: ResourceFQN): Promise<{
    fqn: ResourceFQN;
    isRunning: boolean;
    port?: Port;
  }>;
  addResource(resourceFQN: ResourceFQN, autoStart?: boolean): Promise<void>;
  queueStartResource(resourceFQN: ResourceFQN): Promise<void>;
  stopResource(resourceFQN: ResourceFQN): Promise<void>;
  startResource(resourceFQN: ResourceFQN): Promise<void>;
  processPendingStarts(): Promise<void>;
  unsafeUseFromLibrary<T = unknown>(key: string): Promise<T>;
  useFromLibrary<T = unknown>(
    key: string,
    defaultValue: (scope: Scope) => Promise<T>,
  ): Promise<T>;
  claimNextAvailablePort(
    key: ResourceFQN | symbol,
    startingFrom?: Port,
    maxPort?: Port,
  ): Promise<Port>;
}

//todo(michael):
// orchestrator would need to be made aware of resource changes while its
// running. For example if we are running in dev mode and alchemy.run is called
// the orchestrator would need to be made aware of changes to what resources
// exist.
// To that effect do we want to provide a listener so that e.g. a tui could be
// told "hey, there is a new resource".
// ^ another good example of this is if a resource shut itself down (e.g. an
// exec script finishes running)

export class DefaultOrchestrator implements Orchestrator {
  private resources: Map<
    ResourceFQN,
    {
      isRunning: boolean;
    }
  > = new Map();
  private readonly scope: Scope;
  private readonly pendingStarts: Set<ResourceFQN> = new Set();
  // Global mutex to prevent any concurrent port claims
  private globalPortClaimMutex: Promise<void> = Promise.resolve();
  //todo(michael):
  // I do not like that this is unknown but we need to be able to
  //provide a place for resource to keep their "junk" like a reference to
  //miniflare.
  // ^ we want to do this rather than having it just a global undefined variable
  // because then it can be references across resources, or even by
  // non-first-party resources. (e.g. if somebody wants to make their own CF
  // worker resource they can use our miniflare instance)
  private readonly library: Map<string, unknown> = new Map();
  private readonly claimedPorts: Map<symbol, Port> = new Map();

  constructor(scope: Scope) {
    this.scope = scope;
    this.resources = new Map();
    this.library = new Map();
  }

  private findScopeByFQN(fqn: ResourceFQN): Scope {
    const segments = fqn.split("/");
    const pathSegments = segments.slice(this.scope.chain.length, -1);

    let currentScope = this.scope;
    for (const segment of pathSegments) {
      const childScope = currentScope.children.get(segment);
      if (!childScope) {
        throw new Error(
          `Scope segment '${segment}' not found in scope chain for FQN: ${fqn}`,
        );
      }
      currentScope = childScope;
    }

    return currentScope;
  }

  async addResource(resourceFQN: ResourceFQN, autoStart = true): Promise<void> {
    this.resources.set(resourceFQN, { isRunning: false });
    if (autoStart) {
      await this.queueStartResource(resourceFQN);
    }
    return;
  }
  init(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    // Stop all running resources
    const entries = Array.from(this.resources.entries()).reverse();
    for (const [resourceFQN, resource] of entries) {
      if (resource.isRunning) {
        await this.stopResource(resourceFQN);
      }
    }
    this.claimedPorts.clear();
    this.pendingStarts.clear();
  }

  async listResources(isRunning?: boolean): Promise<
    Array<{
      fqn: ResourceFQN;
      isRunning: boolean;
      port?: Port;
    }>
  > {
    if (isRunning === undefined) {
      return Array.from(this.resources.entries()).map(([fqn, r]) => ({
        fqn,
        ...r,
        port: this.claimedPorts.get(Symbol.for(fqn)),
      }));
    }
    return Array.from(this.resources.entries())
      .filter(([_, r]) => r.isRunning === isRunning)
      .map(([fqn, r]) => ({
        fqn,
        ...r,
        port: this.claimedPorts.get(Symbol.for(fqn)),
      }));
  }

  async getResource(resourceFQN: ResourceFQN): Promise<{
    fqn: ResourceFQN;
    isRunning: boolean;
    port?: Port;
  }> {
    const resource = this.resources.get(resourceFQN);
    if (!resource) {
      throw new Error(`Resource ${resourceFQN} not found in orchestrator`);
    }
    return {
      fqn: resourceFQN,
      ...resource,
      port: this.claimedPorts.get(Symbol.for(resourceFQN)),
    };
  }

  async queueStartResource(resourceFQN: ResourceFQN): Promise<void> {
    this.pendingStarts.add(resourceFQN);
  }

  async processPendingStarts(): Promise<void> {
    const pendingStartsCopy = Array.from(this.pendingStarts);
    this.pendingStarts.clear();

    for (const resourceFQN of pendingStartsCopy) {
      await this.startResource(resourceFQN);
    }
  }

  public async startResource(resourceFQN: ResourceFQN): Promise<void> {
    const targetScope = this.findScopeByFQN(resourceFQN);
    const resourceID = resourceFQN.split("/").pop()!;

    const resource = targetScope.resources.get(resourceID);
    if (!resource) {
      throw new Error(
        `Resource ${resourceID} not found in scope for FQN ${resourceFQN}`,
      );
    }

    logger.task(resourceID, {
      prefix: "starting",
      prefixColor: "greenBright",
      resource: formatFQN(resourceFQN),
      message: "Starting Resource Locally",
      status: "success",
    });

    const provider: Provider = PROVIDERS.get(
      (resource as PendingResource)[ResourceKind],
    );
    if (!provider) {
      throw new Error(`Provider for resource ${resourceID} not found`);
    }

    const state = await targetScope.state.get(resourceID);
    if (!state) {
      throw new Error(`State for resource ${resourceID} not found`);
    }

    const ctx = context({
      scope: targetScope,
      phase: "dev:start",
      kind: (resource as PendingResource)[ResourceKind],
      id: resourceID,
      fqn: resourceFQN,
      seq: (resource as PendingResource)[ResourceSeq],
      props: state.props,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being started");
      },
    });

    await alchemy.run(
      resourceID,
      {
        isResource: true,
        parent: targetScope,
      },
      async (_scope) => {
        return await provider.localHandler.bind(ctx)(resourceID, state.props);
      },
    );

    this.resources.set(resourceFQN, { isRunning: true });
    logger.task(resourceID, {
      prefix: "started",
      prefixColor: "greenBright",
      resource: formatFQN(resourceFQN),
      message: "Started Resource Locally",
      status: "success",
    });
  }

  async stopResource(resourceFQN: ResourceFQN): Promise<void> {
    const targetScope = this.findScopeByFQN(resourceFQN);
    const resourceID = resourceFQN.split("/").pop()!;

    const resource = targetScope.resources.get(resourceID);
    if (!resource) {
      throw new Error(
        `Resource ${resourceID} not found in scope for FQN ${resourceFQN}`,
      );
    }

    logger.task(resourceID, {
      prefix: "stopping",
      prefixColor: "redBright",
      resource: formatFQN(resourceFQN),
      message: "Stopping Resource Locally",
      status: "success",
    });

    const provider: Provider = PROVIDERS.get(
      (resource as PendingResource)[ResourceKind],
    );
    if (!provider) {
      throw new Error(`Provider for resource ${resourceID} not found`);
    }

    const state = await targetScope.state.get(resourceID);
    if (!state) {
      throw new Error(`State for resource ${resourceID} not found`);
    }

    const ctx = context({
      scope: targetScope,
      phase: "dev:stop",
      kind: (resource as PendingResource)[ResourceKind],
      id: resourceID,
      fqn: resourceFQN,
      seq: (resource as PendingResource)[ResourceSeq],
      props: state.props,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being stopped");
      },
    });

    await alchemy.run(
      resourceID,
      {
        isResource: true,
        parent: targetScope,
      },
      async (_scope) => {
        return await provider.localHandler.bind(ctx)(resourceID, state.props);
      },
    );

    this.resources.set(resourceFQN, { isRunning: false });
    logger.task(resourceID, {
      prefix: "stopped",
      prefixColor: "redBright",
      resource: formatFQN(resourceFQN),
      message: "Stopped Resource Locally",
      status: "success",
    });
  }

  async unsafeUseFromLibrary<T = unknown>(key: string): Promise<T> {
    const value = this.library.get(key);
    if (value === undefined) {
      throw new Error(`Library key ${key} not found`);
    }
    return value as T;
  }

  async useFromLibrary<T = unknown>(
    key: string,
    defaultValue: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    const value = this.library.get(key);
    if (value === undefined && defaultValue) {
      const value = await defaultValue(this.scope);
      this.library.set(key, value);
      return value;
    }
    return value as T;
  }

  //todo(michael): handle windows `ERROR_ABANDONED_WAIT_0` (rarely happens)
  private async getAvailablePort(
    startingFrom = 1024,
    maxPort = 65535,
  ): Promise<Port> {
    if (startingFrom > maxPort) {
      throw new Error(
        `Starting port ${startingFrom} exceeds maximum port ${maxPort}`,
      );
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer();

      server.listen(startingFrom, () => {
        const port = (server.address() as net.AddressInfo)?.port;
        server.close(() => {
          if (port) {
            resolve(port);
          } else {
            reject(new Error("Failed to get port from server"));
          }
        });
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Port is in use, try the next one
          if (startingFrom + 1 > maxPort) {
            reject(
              new Error(
                `No available ports found in range ${startingFrom - (startingFrom - 1024)}-${maxPort}`,
              ),
            );
            return;
          }
          this.getAvailablePort(startingFrom + 1, maxPort)
            .then(resolve)
            .catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  async claimNextAvailablePort(
    key: ResourceFQN | symbol,
    startingFrom?: Port,
    maxPort?: Port,
  ): Promise<Port> {
    let release: () => void;
    const prev = this.globalPortClaimMutex;
    const lock = new Promise<void>((res) => (release = res));
    this.globalPortClaimMutex = prev.then(() => lock);

    try {
      await prev;
      const symbolKey = typeof key === "symbol" ? key : Symbol.for(key);
      const existingPort = this.claimedPorts.get(symbolKey);
      if (existingPort) {
        return existingPort;
      }
      if (typeof key !== "symbol") {
        const resource = this.resources.get(key);
        if (resource == null) {
          throw new Error(`Resource ${key} not found in orchestrator`);
        }
      }

      let port: Port;
      let existing: boolean;
      let start = startingFrom;
      do {
        port = await this.getAvailablePort(start, maxPort);
        existing = Array.from(this.claimedPorts.values()).includes(port);
        if (existing) {
          start = (port + 1) as Port;
        }
      } while (existing);

      this.claimedPorts.set(symbolKey, port);
      return port;
    } finally {
      release!();
    }
  }
}
