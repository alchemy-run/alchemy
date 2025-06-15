import net from "node:net";
import type { ResourceID } from "./resource.ts";
import type { Scope } from "./scope.ts";

export type Port = number;

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
  addResource(resourceId: ResourceID, autoStart?: boolean): Promise<void>;
  startResource(resourceId: ResourceID): Promise<void>;
  stopResource(resourceId: ResourceID): Promise<void>;
  useFromLibrary<T = unknown>(
    key: string,
    defaultValue: () => Promise<T>,
  ): Promise<T>;
  claimNextAvailablePort(
    resourceId: ResourceID,
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
  //todo(michael):
  // I do not like that this is unknown but we need to be able to
  //provide a place for resource to keep their "junk" like a reference to
  //miniflare.
  // ^ we want to do this rather than having it just a global undefined variable
  // because then it can be references across resources, or even by
  // non-first-party resources. (e.g. if somebody wants to make their own CF
  // worker resource they can use our miniflare instance)
  private readonly library: Map<string, unknown> = new Map();

  constructor(scope: Scope) {
    this.scope = scope;
    this.resources = new Map();
    this.library = new Map();
  }
  addResource(resourceId: ResourceID, autoStart = true): Promise<void> {
    this.resources.set(resourceId, { isRunning: autoStart });
    return Promise.resolve();
  }
  init(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {}

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

  async startResource(resourceId: ResourceID): Promise<void> {
    this.resources.set(resourceId, { isRunning: true });
    console.log(`RESOURCE: ${resourceId} STARTED`);
    //todo actually start/stop resource
  }

  async stopResource(resourceId: ResourceID): Promise<void> {
    this.resources.set(resourceId, { isRunning: false });
    //todo actually start/stop resource
  }

  async useFromLibrary<T = unknown>(
    key: string,
    defaultValue: () => Promise<T>,
  ): Promise<T> {
    const value = this.library.get(key);
    if (value === undefined && defaultValue) {
      const value = await defaultValue();
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
    const resource = this.resources.get(resourceId);
    if (resource == null) {
      throw new Error(`Resource ${resourceId} not found in orchestrator`);
    }
    if (resource.port) {
      return resource.port;
    }
    let port: Port;
    let existing: boolean;
    do {
      port = await this.getAvailablePort(startingFrom, maxPort);
      existing = Array.from(this.resources.values()).some(
        (r) => r.port === port,
      );
      if (existing) {
        startingFrom = (port + 1) as Port;
      }
    } while (existing);
    this.resources.set(resourceId, { isRunning: true, port });
    return port;
  }
}
