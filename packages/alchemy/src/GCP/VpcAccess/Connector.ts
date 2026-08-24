import * as vpcaccess from "@distilled.cloud/gcp/vpcaccess_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_LOCATION = "us-central1";
const DEFAULT_NETWORK = "default";
const DEFAULT_MACHINE_TYPE = "e2-micro";
const MAX_NAME_LENGTH = 25;

export type ConnectorSubnet = {
  /**
   * Subnet name (relative, not a full URL). For
   * `.../regions/{region}/subnetworks/{subnetName}` pass `{subnetName}`.
   */
  name: string;
  /**
   * Project that owns the subnet. Defaults to the connector's project.
   */
  projectId?: string;
};

export type ConnectorProps = {
  /**
   * Connector id (the `{connector}` segment of
   * `projects/{project}/locations/{location}/connectors/{connector}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-25 characters and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * connector.
   */
  connectorId?: string;
  /**
   * Region of the connector (`us-central1`, …). Immutable — changing it
   * replaces the connector. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * VPC network name or URL to house the connector. Used with
   * `ipCidrRange` to create an `aet-*` `/28` subnet. Ignored when
   * `subnet` is set. Immutable — changing it replaces the connector.
   * @default "default"
   */
  network?: string;
  /**
   * Unused `/28` CIDR (RFC 4632, e.g. `"10.8.0.0/28"`) used when the
   * connector creates its own subnet in `network`. Required unless
   * `subnet` is set. Immutable — changing it replaces the connector.
   */
  ipCidrRange?: string;
  /**
   * Existing subnet to house the connector (Shared VPC or a subnet you
   * manage). Immutable — changing it replaces the connector. When set,
   * `network` and `ipCidrRange` are not sent.
   */
  subnet?: ConnectorSubnet;
  /**
   * Machine type of the underlying VMs (`e2-micro`, `e2-standard-4`,
   * `f1-micro`).
   * @default "e2-micro"
   */
  machineType?: string;
  /**
   * Minimum instances in the connector's autoscaling group (2–9). Takes
   * precedence over `minThroughput`. Prefer this over throughput.
   */
  minInstances?: number;
  /**
   * Maximum instances in the connector's autoscaling group (3–10). Takes
   * precedence over `maxThroughput`. Prefer this over throughput.
   */
  maxInstances?: number;
  /**
   * Minimum throughput in Mbps for `e2-micro` (multiple of 100, 200–900).
   * Discouraged — use `minInstances`.
   */
  minThroughput?: number;
  /**
   * Maximum throughput in Mbps for `e2-micro` (multiple of 100, 300–1000).
   * Discouraged — use `maxInstances`.
   */
  maxThroughput?: number;
};

export type Connector = Resource<
  "GCP.VpcAccess.Connector",
  ConnectorProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/connectors/{connector}`. */
    name: string;
    /** Connector id (last path segment). */
    connectorId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** VPC network name, if the connector created its own subnet. */
    network: string | undefined;
    /** `/28` CIDR used when the connector created its own subnet. */
    ipCidrRange: string | undefined;
    /** Existing subnet the connector is attached to, if any. */
    subnet: ConnectorSubnet | undefined;
    /** Machine type of the underlying VMs. */
    machineType: string | undefined;
    /** Minimum instances. */
    minInstances: number | undefined;
    /** Maximum instances. */
    maxInstances: number | undefined;
    /** Minimum throughput in Mbps. */
    minThroughput: number | undefined;
    /** Maximum throughput in Mbps. */
    maxThroughput: number | undefined;
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Projects currently using the connector. */
    connectedProjects: ReadonlyArray<string>;
  },
  never,
  Providers
>;

/**
 * A Serverless VPC Access connector.
 *
 * Connectors let Cloud Run, Cloud Functions, and App Engine reach resources
 * in a VPC. The API has no labels or description field — Alchemy treats
 * existence at the computed name as ownership, and `list` returns every
 * connector in the project so `pnpm nuke:gcp` can still clean leaks.
 *
 * `connectorId`, `location`, `network`, `ipCidrRange`, and `subnet` are
 * immutable. `machineType` and min/max instances (or throughput) update
 * in place.
 *
 * ### Creating a Connector
 * **Example:** Generated name on the default VPC
 * ```typescript
 * const connector = yield* GCP.VpcAccess.Connector("Egress", {
 *   ipCidrRange: "10.8.0.0/28",
 *   minInstances: 2,
 *   maxInstances: 3,
 * });
 * ```
 *
 * **Example:** Explicit id, machine type, and scaling
 * ```typescript
 * const connector = yield* GCP.VpcAccess.Connector("Egress", {
 *   connectorId: "app-egress",
 *   location: "us-central1",
 *   network: "default",
 *   ipCidrRange: "10.8.0.0/28",
 *   machineType: "e2-micro",
 *   minInstances: 2,
 *   maxInstances: 4,
 * });
 * ```
 *
 * ### Existing subnet
 * **Example:** Attach to a subnet you manage
 * ```typescript
 * const connector = yield* GCP.VpcAccess.Connector("Egress", {
 *   subnet: { name: subnet.subnetworkName },
 *   minInstances: 2,
 *   maxInstances: 3,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category VpcAccess
 */
export const Connector = Resource<Connector>("GCP.VpcAccess.Connector");

export class ConnectorNotResolved extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorNotResolved",
)<{
  name: string;
}> {}

export class ConnectorRangeMissing extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorRangeMissing",
)<{
  name: string;
  message: string;
}> {}

export class ConnectorFailed extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class ConnectorOperationFailed extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ConnectorOperationPending extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorOperationPending",
)<{
  operation: string;
}> {}

export class ConnectorNotReady extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorNotReady",
)<{
  name: string;
  state: string | undefined;
}> {}

export class ConnectorStillExists extends Data.TaggedError(
  "GCP.VpcAccess.ConnectorStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const linkKey = (value: string | undefined) =>
  value === undefined || value === "" ? "" : lastSegment(value).toLowerCase();

const subnetKey = (subnet: ConnectorSubnet | undefined) => {
  if (subnet === undefined) return "";
  return `${linkKey(subnet.name)}:${(subnet.projectId ?? "").toLowerCase()}`;
};

const resourceName = (project: string, location: string, connectorId: string) =>
  `projects/${project}/locations/${location}/connectors/${connectorId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const connectorsAt = parts.lastIndexOf("connectors");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    connectorId:
      connectorsAt >= 0 && parts[connectorsAt + 1]
        ? parts[connectorsAt + 1]!
        : lastSegment(name),
  };
};

const toSubnet = (
  subnet: vpcaccess.Subnet | undefined,
): ConnectorSubnet | undefined => {
  if (subnet === undefined) return undefined;
  const name = subnet.name ? lastSegment(subnet.name) : undefined;
  if (name === undefined || name.length === 0) {
    return subnet.projectId
      ? { name: "", projectId: subnet.projectId }
      : undefined;
  }
  return subnet.projectId ? { name, projectId: subnet.projectId } : { name };
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "connector";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const toId = (id: string, connectorId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (connectorId !== undefined) return connectorId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const toAttrs = (connector: vpcaccess.Connector, project: string) => {
  const name = connector.name ?? "";
  const parsed = parseName(name);
  const network = connector.network
    ? lastSegment(connector.network)
    : undefined;
  return {
    name,
    connectorId: parsed.connectorId,
    project: parsed.project || project,
    location: parsed.location,
    network,
    ipCidrRange: connector.ipCidrRange,
    subnet: toSubnet(connector.subnet),
    machineType: connector.machineType,
    minInstances: connector.minInstances,
    maxInstances: connector.maxInstances,
    minThroughput: connector.minThroughput,
    maxThroughput: connector.maxThroughput,
    state: connector.state,
    connectedProjects: connector.connectedProjects ?? [],
  };
};

const getByName = (name: string) =>
  vpcaccess
    .getProjectsLocationsConnectors({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitForOperation = (
  operation: vpcaccess.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        return yield* new ConnectorOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new ConnectorOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = vpcaccess.getProjectsLocationsOperations({ name });
    const resolved: Effect.Effect<
      vpcaccess.Operation,
      vpcaccess.GetProjectsLocationsOperationsError,
      vpcaccess.GcpOpContext
    > = Effect.suspend(() =>
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<vpcaccess.Operation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          ),
    );

    const settled: Effect.Effect<
      vpcaccess.Operation,
      | ConnectorOperationFailed
      | ConnectorOperationPending
      | vpcaccess.GetProjectsLocationsOperationsError,
      vpcaccess.GcpOpContext
    > = resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new ConnectorOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => current.error === undefined,
        (current) =>
          new ConnectorOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
    );

    return yield* settled.pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.VpcAccess.ConnectorOperationPending",
        times: 10,
        schedule: Schedule.spaced("20 seconds"),
      }),
    );
  });

const waitUntilReady = (name: string) => {
  const ready: Effect.Effect<
    vpcaccess.Connector,
    | ConnectorNotResolved
    | ConnectorFailed
    | ConnectorNotReady
    | vpcaccess.GetProjectsLocationsConnectorsError,
    vpcaccess.GcpOpContext
  > = getByName(name).pipe(
    Effect.filterOrFail(
      (connector): connector is vpcaccess.Connector => connector !== undefined,
      () => new ConnectorNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (connector) => connector.state !== "ERROR",
      (connector) => new ConnectorFailed({ name, state: connector.state }),
    ),
    Effect.filterOrFail(
      (connector) =>
        connector.state === "READY" || connector.state === undefined,
      (connector) => new ConnectorNotReady({ name, state: connector.state }),
    ),
  );
  return ready.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.VpcAccess.ConnectorNotResolved" ||
        error._tag === "GCP.VpcAccess.ConnectorNotReady",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );
};

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((connector) =>
      connector === undefined
        ? Effect.void
        : Effect.fail(new ConnectorStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.VpcAccess.ConnectorStillExists",
      times: 10,
      schedule: Schedule.spaced("20 seconds"),
    }),
  );

const listConnectors = (parent: string) =>
  Effect.gen(function* () {
    const found: vpcaccess.Connector[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* vpcaccess.listProjectsLocationsConnectors({
        parent,
        pageSize: 100,
        pageToken,
      });
      found.push(...(response.connectors ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

const listAt = (parent: string) =>
  listConnectors(parent).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as vpcaccess.Connector[]),
    ),
    Effect.catchTag("Forbidden", () =>
      Effect.succeed([] as vpcaccess.Connector[]),
    ),
  );

const listLocations = (project: string) =>
  Effect.gen(function* () {
    const found: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* vpcaccess.listProjectsLocations({
        name: `projects/${project}`,
        pageSize: 100,
        pageToken,
      });
      for (const location of response.locations ?? []) {
        if (location.name) found.push(location.name);
      }
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    Effect.catchTag("Forbidden", () => Effect.succeed([] as string[])),
  );

const createBody = (news: ConnectorProps): vpcaccess.Connector => {
  const body: vpcaccess.Connector = {};
  if (news.subnet !== undefined) {
    body.subnet = {
      name: lastSegment(news.subnet.name),
      projectId: news.subnet.projectId,
    };
  } else {
    if (news.network !== undefined || news.ipCidrRange !== undefined) {
      body.network = news.network ? lastSegment(news.network) : DEFAULT_NETWORK;
    }
    if (news.ipCidrRange !== undefined) {
      body.ipCidrRange = news.ipCidrRange;
    }
  }
  if (news.machineType !== undefined) {
    body.machineType = news.machineType;
  }
  if (news.minInstances !== undefined) {
    body.minInstances = news.minInstances;
  }
  if (news.maxInstances !== undefined) {
    body.maxInstances = news.maxInstances;
  }
  if (news.minThroughput !== undefined) {
    body.minThroughput = news.minThroughput;
  }
  if (news.maxThroughput !== undefined) {
    body.maxThroughput = news.maxThroughput;
  }
  return body;
};

export const ConnectorProvider = () =>
  Provider.succeed(Connector, {
    stables: [
      "name",
      "connectorId",
      "project",
      "location",
      "network",
      "ipCidrRange",
      "subnet",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.connectorId ?? output?.connectorId;
      const nextId = news.connectorId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const locationChanged = previousLocation !== nextLocation;

      const previousNetwork = linkKey(olds?.network ?? output?.network);
      const nextNetwork =
        news.network !== undefined ? linkKey(news.network) : previousNetwork;
      const networkChanged =
        news.network !== undefined && nextNetwork !== previousNetwork;

      const previousCidr = olds?.ipCidrRange ?? output?.ipCidrRange ?? "";
      const cidrChanged =
        news.ipCidrRange !== undefined && news.ipCidrRange !== previousCidr;

      const previousSubnet = subnetKey(olds?.subnet ?? output?.subnet);
      const nextSubnet =
        news.subnet !== undefined ? subnetKey(news.subnet) : previousSubnet;
      const subnetChanged =
        news.subnet !== undefined && nextSubnet !== previousSubnet;

      if (
        !idChanged &&
        !locationChanged &&
        !networkChanged &&
        !cidrChanged &&
        !subnetChanged
      ) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst: !idChanged && !locationChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectorId = yield* toId(
        id,
        olds?.connectorId,
        output?.connectorId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, connectorId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      // Connectors have no labels or description. Existence at the computed
      // name is ownership — the same approach Cloud KMS KeyRing uses.
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listLocations(env.project);
        if (parents.length === 0) {
          parents.push(parentOf(env.project, DEFAULT_LOCATION));
        }
        const pages = yield* Effect.forEach(
          parents,
          (parent) => listAt(parent),
          {
            concurrency: 4,
          },
        );
        return pages.flat().map((connector) => toAttrs(connector, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const connectorId = yield* toId(
        id,
        news.connectorId,
        output?.connectorId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, connectorId);

      if (news.subnet === undefined && news.ipCidrRange === undefined) {
        return yield* new ConnectorRangeMissing({
          name,
          message:
            "VPC Access connectors require `ipCidrRange` (with optional `network`) or `subnet`.",
        });
      }

      let current = yield* getByName(name);

      if (current !== undefined && current.state === "DELETING") {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current !== undefined && current.state === "ERROR") {
        return yield* new ConnectorFailed({
          name,
          state: current.state,
        });
      }

      if (current === undefined) {
        const created = yield* vpcaccess
          .createProjectsLocationsConnectors({
            parent: parentOf(env.project, location),
            connectorId,
            body: createBody(news),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.VpcAccess.ConnectorOperationPending",
              () => Effect.void,
            ),
          );
        } else {
          const raced = yield* getByName(name);
          if (raced === undefined) {
            return yield* new ConnectorNotResolved({ name });
          }
        }
        current = yield* waitUntilReady(name);
      } else if (current.state === "CREATING" || current.state === "UPDATING") {
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new ConnectorNotResolved({ name });
      }

      const desiredMachine = news.machineType ?? DEFAULT_MACHINE_TYPE;
      const machineChanged =
        news.machineType !== undefined &&
        (current.machineType ?? DEFAULT_MACHINE_TYPE) !== desiredMachine;
      const minChanged =
        news.minInstances !== undefined &&
        news.minInstances !== current.minInstances;
      const maxChanged =
        news.maxInstances !== undefined &&
        news.maxInstances !== current.maxInstances;
      const minThroughputChanged =
        news.minThroughput !== undefined &&
        news.minThroughput !== current.minThroughput;
      const maxThroughputChanged =
        news.maxThroughput !== undefined &&
        news.maxThroughput !== current.maxThroughput;
      const instancesChanged = minChanged || maxChanged;

      if (
        machineChanged ||
        instancesChanged ||
        minThroughputChanged ||
        maxThroughputChanged
      ) {
        const updateMask = [
          machineChanged ? "machineType" : undefined,
          instancesChanged ? "minInstances" : undefined,
          instancesChanged ? "maxInstances" : undefined,
          minThroughputChanged ? "minThroughput" : undefined,
          maxThroughputChanged ? "maxThroughput" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation = yield* vpcaccess.patchProjectsLocationsConnectors({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            machineType: news.machineType ?? current.machineType,
            minInstances: news.minInstances ?? current.minInstances,
            maxInstances: news.maxInstances ?? current.maxInstances,
            minThroughput: news.minThroughput ?? current.minThroughput,
            maxThroughput: news.maxThroughput ?? current.maxThroughput,
          },
        });
        yield* waitForOperation(operation).pipe(
          Effect.catchTag(
            "GCP.VpcAccess.ConnectorOperationPending",
            () => Effect.void,
          ),
        );
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vpcaccess
        .deleteProjectsLocationsConnectors({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("8 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true }).pipe(
          Effect.catchTag(
            "GCP.VpcAccess.ConnectorOperationPending",
            () => Effect.void,
          ),
        );
      }
      yield* waitUntilGone(output.name);
    }),
  });
