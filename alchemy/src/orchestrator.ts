import net from "node:net";
import { alchemy } from "./alchemy.ts";
import { context } from "./context.ts";
import type { Provider, ResourceID } from "./resource.ts";
import {
  PROVIDERS,
  ResourceFQN,
  ResourceKind,
  ResourceSeq,
  type PendingResource,
} from "./resource.ts";
import type { Scope } from "./scope.ts";
import { formatFQN } from "./util/cli.ts";
import { logger } from "./util/logger.ts";

export type Port = number;

//todo(michael): document what all of these do
export interface Orchestrator {
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
  listResources(isRunning?: boolean): Promise<
    Array<{
      id: ResourceID;
      isRunning: boolean;
      port?: Port;
    }>
  >;
  getResource(resourceId: ResourceID): Promise<{
    id: ResourceID;
    isRunning: boolean;
    port?: Port;
  }>;
  addResource(resourceId: ResourceID, autoStart?: boolean): Promise<void>;
  queueStartResource(resourceId: ResourceID): Promise<void>;
  stopResource(resourceId: ResourceID): Promise<void>;
  startResource(resourceId: ResourceID): Promise<void>;
  processPendingStarts?(): Promise<void>;
  unsafeUseFromLibrary<T = unknown>(key: string): Promise<T>;
  useFromLibrary<T = unknown>(
    key: string,
    defaultValue: (scope: Scope) => Promise<T>,
  ): Promise<T>;
  claimNextAvailablePort(
    resourceId: ResourceID,
    startingFrom?: Port,
    maxPort?: Port,
  ): Promise<Port>;
  claimNextAvailablePortAnonymously(
    key: symbol,
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
    ResourceID,
    {
      isRunning: boolean;
      port?: Port;
    }
  > = new Map();
  private readonly scope: Scope;
  private readonly pendingStarts: Set<ResourceID> = new Set();
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
  private readonly anonymousClaimedPorts: Map<symbol, Port> = new Map();

  constructor(scope: Scope) {
    this.scope = scope;
    this.resources = new Map();
    this.library = new Map();
  }
  async addResource(resourceId: ResourceID, autoStart = true): Promise<void> {
    this.resources.set(resourceId, { isRunning: false });
    if (autoStart) {
      await this.queueStartResource(resourceId);
    }
    return;
  }
  init(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    // Process any pending starts before shutdown
    await this.processPendingStarts();
  }

  async listResources(isRunning?: boolean): Promise<
    Array<{
      id: ResourceID;
      isRunning: boolean;
      port?: Port;
    }>
  > {
    if (isRunning === undefined) {
      return Array.from(this.resources.entries()).map(([id, r]) => ({
        id,
        ...r,
      }));
    }
    return Array.from(this.resources.entries())
      .filter(([_, r]) => r.isRunning === isRunning)
      .map(([id, r]) => ({
        id,
        ...r,
      }));
  }

  async getResource(resourceId: ResourceID): Promise<{
    id: ResourceID;
    isRunning: boolean;
    port?: Port;
  }> {
    const resource = this.resources.get(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found in orchestrator`);
    }
    return {
      id: resourceId,
      ...resource,
    };
  }

  //todo(michael):
  // awaiting this relaly should wait until internal start finishes
  // but i'm worried that might confused people in dev:start who do choose to
  // await it and then get stuck since the scope never finishes and thus it
  // never solves
  async queueStartResource(resourceId: ResourceID): Promise<void> {
    this.pendingStarts.add(resourceId);
  }

  async processPendingStarts(): Promise<void> {
    const pendingStartsCopy = Array.from(this.pendingStarts);
    this.pendingStarts.clear();

    for (const resourceId of pendingStartsCopy) {
      await this.startResource(resourceId);
    }
  }

  public async startResource(resourceId: ResourceID): Promise<void> {
    const resource = this.scope.resources.get(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found in scope`);
    }

    logger.task(resourceId, {
      prefix: "starting",
      prefixColor: "greenBright",
      resource: formatFQN(resource[ResourceFQN]),
      message: "Starting Resource Locally",
      status: "success",
    });

    const provider: Provider = PROVIDERS.get(
      (resource as PendingResource)[ResourceKind],
    );
    if (!provider) {
      throw new Error(`Provider for resource ${resourceId} not found`);
    }

    const state = await this.scope.state.get(resourceId);
    if (!state) {
      throw new Error(`State for resource ${resourceId} not found`);
    }

    const ctx = context({
      scope: this.scope,
      phase: "dev:start",
      kind: (resource as PendingResource)[ResourceKind],
      id: resourceId,
      fqn: (resource as PendingResource)[ResourceFQN],
      seq: (resource as PendingResource)[ResourceSeq],
      props: state.props,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being started");
      },
    });

    await alchemy.run(
      resourceId,
      {
        isResource: true,
        parent: this.scope,
      },
      async (scope) => {
        return await provider.localHandler.bind(ctx)(resourceId, state.props);
      },
    );

    this.resources.set(resourceId, { ...resource, isRunning: true });
    logger.task(resourceId, {
      prefix: "started",
      prefixColor: "greenBright",
      resource: formatFQN(resource[ResourceFQN]),
      message: "Started Resource Locally",
      status: "success",
    });
  }

  async stopResource(resourceId: ResourceID): Promise<void> {
    const resource = this.scope.resources.get(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found in scope`);
    }

    logger.task(resourceId, {
      prefix: "stopping",
      prefixColor: "redBright",
      resource: formatFQN(resource[ResourceFQN]),
      message: "Stopping Resource Locally",
      status: "success",
    });

    const provider: Provider = PROVIDERS.get(
      (resource as PendingResource)[ResourceKind],
    );
    if (!provider) {
      throw new Error(`Provider for resource ${resourceId} not found`);
    }

    const state = await this.scope.state.get(resourceId);
    if (!state) {
      throw new Error(`State for resource ${resourceId} not found`);
    }

    const ctx = context({
      scope: this.scope,
      phase: "dev:stop",
      kind: (resource as PendingResource)[ResourceKind],
      id: resourceId,
      fqn: (resource as PendingResource)[ResourceFQN],
      seq: (resource as PendingResource)[ResourceSeq],
      props: state.props,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being stopped");
      },
    });

    await alchemy.run(
      resourceId,
      {
        isResource: true,
        parent: this.scope,
      },
      async (_scope) => {
        return await provider.localHandler.bind(ctx)(resourceId, state.props);
      },
    );

    this.resources.set(resourceId, { ...resource, isRunning: true });
    logger.task(resourceId, {
      prefix: "stopped",
      prefixColor: "redBright",
      resource: formatFQN(resource[ResourceFQN]),
      message: "Stopped Resource Locally",
      status: "success",
    });
    //todo actually start/stop resource
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
    resourceId: ResourceID,
    startingFrom?: Port,
    maxPort?: Port,
  ): Promise<Port> {
    // Global mutex lock: all port claims must be sequential
    let release: () => void;
    const prev = this.globalPortClaimMutex;
    const lock = new Promise<void>((res) => (release = res));
    this.globalPortClaimMutex = prev.then(() => lock);

    try {
      await prev; // Wait for previous claim to finish

      const resource = this.resources.get(resourceId);
      if (resource == null) {
        throw new Error(`Resource ${resourceId} not found in orchestrator`);
      }
      if (resource.port) {
        return resource.port;
      }
      let port: Port;
      let existing: boolean;
      let start = startingFrom;
      do {
        port = await this.getAvailablePort(start, maxPort);
        existing =
          Array.from(this.resources.values()).some((r) => r.port === port) ||
          Array.from(this.anonymousClaimedPorts.values()).includes(port);
        if (existing) {
          start = (port + 1) as Port;
        }
      } while (existing);
      // Preserve the existing isRunning state when setting the port
      this.resources.set(resourceId, { ...resource, port });
      return port;
    } finally {
      // Release the global mutex
      release!();
    }
  }

  async claimNextAvailablePortAnonymously(
    key: symbol,
    startingFrom?: Port,
    maxPort?: Port,
  ): Promise<Port> {
    // Global mutex lock: all port claims must be sequential
    let release: () => void;
    const prev = this.globalPortClaimMutex;
    const lock = new Promise<void>((res) => (release = res));
    this.globalPortClaimMutex = prev.then(() => lock);

    try {
      await prev; // Wait for previous claim to finish

      // Check if we already have a port for this key
      const existingPort = this.anonymousClaimedPorts.get(key);
      if (existingPort) {
        return existingPort;
      }

      let port: Port;
      let existing: boolean;
      let start = startingFrom;
      do {
        port = await this.getAvailablePort(start, maxPort);
        existing =
          Array.from(this.resources.values()).some((r) => r.port === port) ||
          Array.from(this.anonymousClaimedPorts.values()).includes(port);
        if (existing) {
          start = (port + 1) as Port;
        }
      } while (existing);

      // Add the port to the anonymous claimed ports map
      this.anonymousClaimedPorts.set(key, port);
      return port;
    } finally {
      // Release the global mutex
      release!();
    }
  }
}
