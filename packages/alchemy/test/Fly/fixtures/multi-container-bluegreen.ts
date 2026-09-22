import { deepEqual } from "@/Diff";
import { reconcileBlueGreen } from "@/Fly/bluegreen";
import { makeMachineLeases } from "@/Fly/leases";
import { sameContainers } from "@/Fly/MachineContainers";
import { alchemyMetadataKeys as keys } from "@/Fly/Metadata";
import {
  configuredCheckNames,
  sameServices,
  type ReconcileReplicasInput,
} from "@/Fly/replicas";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { reply } from "./protocol-branches.ts";

export const appName = "multi-container-protocol";
export const pins = {
  api: `registry.test/api@sha256:${"a".repeat(64)}`,
  worker: `registry.test/worker@sha256:${"b".repeat(64)}`,
};
export const ownership = {
  [keys.stack]: appName,
  [keys.stage]: "pure",
  [keys.id]: "Worker",
  [keys.type]: "Fly.Machine",
};
export const metadata = {
  ...ownership,
  [keys.instance]: "multi-container-instance",
  [keys.fqn]: `${appName}/pure/Worker`,
  [keys.baseName]: "multi-worker",
};
export const initialConfig: machines.FlyMachineConfig = {
  containers: [
    { name: "worker", image: pins.worker },
    { name: "api", image: pins.api },
  ],
  checks: { ready: { type: "http", port: 80, path: "/" } },
  stop_config: { signal: "SIGTERM", timeout: "1s" },
};
const makeInput = (
  config: machines.FlyMachineConfig,
): ReconcileReplicasInput => ({
  appName,
  id: "Worker",
  type: "Fly.Machine",
  resourceInstanceId: metadata[keys.instance],
  fqn: metadata[keys.fqn],
  baseName: metadata[keys.baseName],
  region: "ord",
  count: 2,
  disks: [],
  policy: {
    bluegreen: true,
    healthTimeoutMs: 1_000,
    shutdown: { signal: "SIGTERM", timeout: "1s", timeoutMs: 1_000 },
  },
  buildConfig: ({ metadata, mounts }) => ({ ...config, metadata, mounts }),
  configDrifted: (machine, { metadata, mounts }) =>
    !sameContainers(machine.config?.containers, config.containers) ||
    !sameServices(machine.config?.services, config.services) ||
    !deepEqual(machine.config?.metadata, metadata) ||
    !deepEqual(machine.config?.mounts, mounts) ||
    !deepEqual(machine.config?.checks, config.checks) ||
    !deepEqual(machine.config?.stop_config, config.stop_config),
});
export const reconcileWith = (
  config: machines.FlyMachineConfig = initialConfig,
) =>
  Effect.gen(function* () {
    const leases = yield* makeMachineLeases(appName);
    return yield* reconcileBlueGreen(
      makeInput(config),
      ownership,
      metadata,
      leases,
    );
  }).pipe(Effect.scoped);
export const reconcile = reconcileWith();
export const serviceConfig: machines.FlyMachineConfig = {
  ...initialConfig,
  services: [
    {
      protocol: "tcp",
      internal_port: 80,
      autostop: "stop",
      min_machines_running: 1,
      checks: [{ type: "http", port: 80, path: "/" }],
    },
  ],
};
export const singleConfig: machines.FlyMachineConfig = {
  image: `registry.test/single@sha256:${"e".repeat(64)}`,
  checks: initialConfig.checks,
  stop_config: initialConfig.stop_config,
};
export const replacementConfig: machines.FlyMachineConfig = {
  ...initialConfig,
  containers: [
    { name: "worker", image: `registry.test/worker@sha256:${"c".repeat(64)}` },
    { name: "api", image: pins.api },
  ],
};

const Body = Schema.Struct({
  name: Schema.optional(Schema.String),
  config: Schema.optional(Schema.toType(machines.FlyMachineConfig)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  skip_launch: Schema.optional(Schema.Boolean),
});
export interface JournalEvent {
  method: string;
  path: string;
  machineId?: string;
  phase?: string;
}
export const multiContainerClient = (
  options: {
    failOnce?:
      | "create-response"
      | "restore-response"
      | "uncordon"
      | "active"
      | "delete";
    failOnNth?: number;
    staleAfterUpdate?: boolean;
  } = {},
) =>
  Effect.sync(() => {
    const events: JournalEvent[] = [];
    const machinesById = new Map<string, machines.Machine>();
    let nextId = 0;
    let nextVersion = 0;
    let failed = false;
    let armed = options.failOnce;
    let failOnNth = options.failOnNth ?? 1;
    let matches = 0;
    let afterActive:
      | ((machines: Map<string, machines.Machine>) => void)
      | undefined;
    const tamperAfterActive = (
      callback: (machines: Map<string, machines.Machine>) => void,
    ) => {
      afterActive = callback;
    };
    const arm = (boundary: typeof options.failOnce, occurrence = 1) => {
      armed = boundary;
      failOnNth = occurrence;
      matches = 0;
      failed = false;
    };
    const fail = (boundary: typeof options.failOnce) => {
      if (armed !== boundary || failed) return false;
      matches++;
      if (matches !== failOnNth) return false;
      failed = true;
      return true;
    };
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.sync(() => {
          const path = new URL(request.url).pathname;
          const body = Schema.decodeUnknownSync(Body)(
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {},
          );
          const match = path.match(
            new RegExp(`^/v1/apps/${appName}/machines/([^/]+)(?:/(.*))?$`),
          );
          const machineId = match?.[1];
          const action = match?.[2];
          events.push({
            method: request.method,
            path,
            machineId,
            phase: body.metadata?.[keys.phase],
          });
          if (path === `/v1/apps/${appName}/machines`) {
            if (request.method === "GET")
              return reply(request, [...machinesById.values()]);
            if (request.method === "POST") {
              const id = `controlled-${++nextId}`;
              const machine: machines.Machine = {
                id,
                instance_id: `instance-${++nextVersion}`,
                name: body.name,
                region: "ord",
                state: body.skip_launch ? "stopped" : "started",
                cordoned: true,
                config: body.config,
                image_ref: body.config?.image
                  ? {
                      registry: "registry.test",
                      repository: "single",
                      digest: `sha256:${"e".repeat(64)}`,
                    }
                  : undefined,
                checks: configuredCheckNames(body.config).map((name) => ({
                  name,
                  status: "passing" as const,
                })),
              };
              machinesById.set(id, machine);
              return fail("create-response")
                ? reply(request, { error: "Machine name already exists" }, 409)
                : reply(request, machine);
            }
          }
          if (!machineId)
            throw new Error(
              `Unexpected controlled request: ${request.method} ${path}`,
            );
          const machine = machinesById.get(machineId);
          if (action === "lease") {
            if (request.method === "POST")
              return reply(request, {
                data: {
                  nonce: "pure-lease",
                  expires_at: Math.floor(now / 1000) + 120,
                },
              });
            if (request.method === "DELETE") return reply(request, {});
          }
          if (action === "wait" && request.method === "GET")
            return reply(request, {});
          if (request.method === "GET" && !action)
            return machine
              ? reply(request, machine)
              : reply(request, { error: "not found" }, 404);
          if (!machine) return reply(request, { error: "not found" }, 404);
          if (action === "metadata" && request.method === "PUT") {
            if (body.metadata?.[keys.phase] === "active" && fail("active"))
              return reply(
                request,
                { error: "controlled commit interruption" },
                400,
              );
            machinesById.set(machineId, {
              ...machine,
              config: { ...machine.config, metadata: body.metadata },
            });
            if (body.metadata?.[keys.phase] === "active" && afterActive) {
              const callback = afterActive;
              afterActive = undefined;
              callback(machinesById);
            }
            return reply(request, {});
          }
          if (action === "uncordon" && request.method === "POST") {
            if (fail("uncordon"))
              return reply(
                request,
                { error: "controlled promotion interruption" },
                400,
              );
            machinesById.set(machineId, { ...machine, cordoned: false });
            return reply(request, {});
          }
          if (action === "cordon" && request.method === "POST") {
            machinesById.set(machineId, { ...machine, cordoned: true });
            return reply(request, {});
          }
          if (request.method === "POST" && !action && !body.config) {
            const started = {
              ...machine,
              state: "started" as const,
              checks: configuredCheckNames(machine.config).map((name) => ({
                name,
                status: "passing" as const,
              })),
            };
            machinesById.set(machineId, started);
            return reply(request, started);
          }
          if (request.method === "POST" && !action && body.config) {
            const updated = {
              ...machine,
              instance_id: `instance-${++nextVersion}`,
              config: body.config,
              checks: options.staleAfterUpdate
                ? []
                : configuredCheckNames(body.config).map((name) => ({
                    name,
                    status: "passing" as const,
                  })),
            };
            machinesById.set(machineId, updated);
            return fail("restore-response")
              ? reply(
                  request,
                  { error: "controlled lost restoration response" },
                  504,
                )
              : reply(request, updated);
          }
          if (request.method === "DELETE" && !action) {
            if (fail("delete"))
              return reply(
                request,
                { error: "controlled retirement interruption" },
                400,
              );
            machinesById.delete(machineId);
            return reply(request, {});
          }
          if (action === "stop" && request.method === "POST") {
            machinesById.set(machineId, { ...machine, state: "stopped" });
            return reply(request, {});
          }
          throw new Error(
            `Unexpected controlled request: ${request.method} ${path}`,
          );
        });
      }),
    );
    return { client, events, machines: machinesById, arm, tamperAfterActive };
  });
