import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import * as Node from "@distilled.cloud/celld/node";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { deepEqual } from "../Diff.ts";
import {
  APPLICATION_GRAPH_BINDING_PREFIX,
  APPLICATION_GRAPH_METADATA,
  APPLICATION_OPERATOR_CLASSES,
  APPLICATION_OPERATOR_FEATURES,
} from "./ApplicationGraph.ts";
import { canonicalJson } from "./Deployment/Objects.ts";
import {
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
} from "./Deployment/Publication.ts";
import { FleetStorage, type Store } from "./FleetStorage.ts";
import type { FleetConnection } from "./Host.ts";
import {
  makeLocalFleetOperator,
  FleetOperator,
  OperatorError,
  type FleetOperatorService,
} from "./OperatorClient.ts";

export const ManagementDeployment = Schema.Struct({
  pointer: Schema.toType(Node.DeployPointer),
  manifest: Schema.toType(Node.Manifest),
});
export const ManagementGraph = Schema.Struct({
  root: ManagementDeployment,
  workers: Schema.Array(ManagementDeployment),
});
export type ManagementGraph = typeof ManagementGraph.Type;

/** Matching point-in-time storage observations bracket acknowledged forced root reloads. */
export const RootReloadProof = Schema.Struct({
  assurance: Schema.Literal("forced-root-reload"),
  namedAdoption: Schema.Literal("not-observed"),
  root: Schema.toType(Node.DeployPointer),
  snapshots: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      etag: Schema.String,
      sha256: Schema.String,
    }),
  ),
  nodes: Schema.Array(
    Schema.Struct({
      session: Schema.String,
      endpoint: Schema.String,
      outcome: Schema.Literal("adopted"),
      generation: Schema.Number,
      version: Schema.String,
      prefix: Schema.String,
      stateReads: Schema.Number,
    }),
  ),
});
export type RootReloadProof = typeof RootReloadProof.Type;

/** Root identity evidence is not evidence of exact root or named manifest adoption. */
export const ReloadEvidence = Schema.Struct({
  proof: Schema.optional(RootReloadProof),
  assurance: Schema.Literal("root-identity-only"),
  nodes: Schema.Array(
    Schema.Struct({
      session: Schema.String,
      generation: Schema.Number,
      version: Schema.String,
      prefix: Schema.String,
    }),
  ),
});
export type ReloadEvidence = typeof ReloadEvidence.Type;

/** Native graph-build inference under the publisher lock, not scheduler or event-delivery evidence. */
export const ActivateEvidence = Schema.Struct({
  assurance: Schema.Literal("locked-graph-generation"),
  cronDelivery: Schema.Literal("not-observed"),
  graphRevision: Schema.String,
  publicationRevision: Schema.String,
  proof: RootReloadProof,
});
export type ActivateEvidence = typeof ActivateEvidence.Type;

/** Messages deliberately omit SDK causes, request bodies and authentication material. */
export class FleetManagementError extends Data.TaggedError(
  "Celld.FleetManagementError",
)<{
  readonly reason:
    | "configuration"
    | "discovery"
    | "transport"
    | "drift"
    | "membership-changed"
    | "reload-failed"
    | "state-unavailable"
    | "swap-pending"
    | "unobservable";
  readonly message: string;
  readonly evidence?: ReloadEvidence;
}> {}

export interface FleetManagementService {
  /** Reload every discovered live node and verify only its observable root identity. */
  readonly reload: (
    connection: FleetConnection,
    graph: ManagementGraph,
  ) => Effect.Effect<ReloadEvidence, FleetManagementError>;
  /** Require locked publication inputs and infer graph installation from acknowledged native builds. */
  readonly activate: (
    connection: FleetConnection,
    graph: ManagementGraph,
  ) => Effect.Effect<ActivateEvidence, FleetManagementError>;
  /** Signed native D1 requests; a failed mutation is never replayed. */
  readonly operator: FleetOperatorService;
}

export class FleetManagement extends Context.Service<
  FleetManagement,
  FleetManagementService
>()("Celld.FleetManagement") {}

export interface ManagementOptions {
  /** Only this private internal listener port is admitted. @default 8081 */
  readonly internalPort?: number;
  /** Refuse activation/discovery below this live membership count. @default 1 */
  readonly minimumNodes?: number;
  /** Bound discovery and management fanout. @default 64 */
  readonly maximumNodes?: number;
}

const fail = (reason: FleetManagementError["reason"], message: string) =>
  Effect.fail(new FleetManagementError({ reason, message }));
const decode = <A>(schema: Schema.Schema<A>, value: unknown) =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(
      () =>
        new FleetManagementError({
          reason: "configuration",
          message: "Invalid private Celld management record or request.",
        }),
    ),
  );
const json = (body: Uint8Array) =>
  Effect.try({
    try: () =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    catch: () =>
      new FleetManagementError({
        reason: "configuration",
        message: "Invalid private Celld management JSON.",
      }),
  });
const get = (store: Store, key: string) =>
  store.get(key).pipe(
    Effect.mapError(
      () =>
        new FleetManagementError({
          reason: "transport",
          message: "Cannot read private Celld management state.",
        }),
    ),
  );
const sessionName = (value: string) =>
  /^[a-zA-Z0-9_.-]{1,128}$/.test(value) && value !== "." && value !== "..";

/** Admit literal RFC1918 IPv4 only: no DNS rebinding, public IPs, loopback or metadata hosts. */
export const privateNodeEndpoint = (address: string, port = 8081) =>
  Effect.gen(function* () {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(
      address,
    );
    if (!match || !Number.isInteger(port) || port < 1 || port > 65535)
      return yield* fail(
        "configuration",
        "Celld nodes must advertise a literal private IPv4 address and the configured internal port.",
      );
    const octets = match.slice(1, 5).map(Number);
    if (
      octets.some(
        (octet, i) => octet > 255 || String(octet) !== match[i + 1],
      ) ||
      Number(match[5]) !== port ||
      String(port) !== match[5] ||
      !(
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      )
    ) {
      return yield* fail(
        "configuration",
        "Celld node address is outside the private management address policy.",
      );
    }
    return `http://${address}`;
  });

const Lease = Schema.Struct({
  node: Schema.String,
  addr: Schema.String,
  expires_ms: Schema.Number,
  peer_protocol: Schema.Number,
});
export interface LiveManagementNode {
  readonly session: string;
  readonly endpoint: string;
}

export const discoverManagementNodes = (
  store: Store,
  options: ManagementOptions = {},
) =>
  Effect.gen(function* () {
    const minimum = options.minimumNodes ?? 1;
    const maximum = options.maximumNodes ?? 64;
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      minimum < 1 ||
      maximum < minimum ||
      maximum > 128
    )
      return yield* fail(
        "configuration",
        "Invalid Celld management membership bounds.",
      );
    const entries = yield* store.list("nodes/").pipe(
      Effect.mapError(
        () =>
          new FleetManagementError({
            reason: "transport",
            message: "Cannot enumerate Celld node sessions.",
          }),
      ),
    );
    if (entries.length > 4096)
      return yield* fail(
        "discovery",
        "Celld node discovery exceeds the bounded lease inventory.",
      );
    const now = yield* Clock.currentTimeMillis;
    const nodes: LiveManagementNode[] = [];
    for (const entry of [...entries].sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      const match = /^nodes\/([^/]+)\.json$/.exec(entry.key);
      if (!match || !sessionName(match[1]!))
        return yield* fail("discovery", "Invalid Celld node lease key.");
      const object = yield* get(store, entry.key);
      if (!object) continue;
      const lease = yield* decode(Lease, yield* json(object.body));
      if (lease.node !== match[1] || !Number.isSafeInteger(lease.expires_ms))
        return yield* fail(
          "discovery",
          "Celld node lease key and session do not match.",
        );
      if (lease.expires_ms <= now) continue;
      if (lease.peer_protocol !== 5)
        return yield* fail(
          "discovery",
          "Celld management requires peer protocol v5.",
        );
      const endpoint = yield* privateNodeEndpoint(
        lease.addr,
        options.internalPort,
      );
      if (nodes.some((node) => node.endpoint === endpoint))
        return yield* fail(
          "discovery",
          "Multiple live Celld sessions advertise the same address.",
        );
      nodes.push({ session: lease.node, endpoint });
      if (nodes.length > maximum)
        return yield* fail(
          "discovery",
          "Celld live membership exceeds the configured bound.",
        );
    }
    if (nodes.length < minimum)
      return yield* fail(
        "discovery",
        "Too few live Celld nodes for private management.",
      );
    return nodes;
  });

const loadPeerKey = (store: Store) =>
  Effect.gen(function* () {
    const object = yield* get(store, "fleet/peer-auth.json");
    if (!object)
      return yield* fail(
        "configuration",
        "Celld fleet peer authentication is not initialized.",
      );
    const secret = yield* decode(
      Schema.Struct({ version: Schema.Literal(1), key: Schema.String }),
      yield* json(object.body),
    );
    if (!/^[a-fA-F0-9]{64}$/.test(secret.key))
      return yield* fail(
        "configuration",
        "Invalid Celld fleet peer authentication configuration.",
      );
    return yield* Effect.sync(() =>
      Redacted.make(new Uint8Array(Buffer.from(secret.key, "hex"))),
    );
  });

const checkGraph = (store: Store, value: ManagementGraph) =>
  Effect.gen(function* () {
    const graph = yield* decode(ManagementGraph, value);
    const snapshots: { key: string; etag: string; sha256: string }[] = [];
    const snapshot = (
      key: string,
      object: { body: Uint8Array; etag: string },
    ) =>
      Effect.sync(() => {
        snapshots.push({
          key,
          etag: object.etag,
          sha256: createHash("sha256").update(object.body).digest("hex"),
        });
      });
    const all = [graph.root, ...graph.workers];
    if (
      all.length > 128 ||
      new Set(all.map((item) => item.pointer.script_name)).size !== all.length
    )
      return yield* fail(
        "configuration",
        "Invalid or oversized Celld management graph.",
      );
    for (const item of all) {
      const pointer = item.pointer;
      if (
        !pointer.script_name ||
        !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(
          pointer.script_name,
        ) ||
        !/^[a-f0-9]{16}$/.test(pointer.version) ||
        pointer.prefix !== `deploy/${pointer.script_name}/${pointer.version}` ||
        pointer.rollout.percent !== 100 ||
        item.manifest.script_name !== pointer.script_name ||
        item.manifest.version !== pointer.version
      )
        return yield* fail(
          "configuration",
          "Invalid Celld deployment identity for management.",
        );
      const named = yield* get(
        store,
        `deploy/${pointer.script_name}/current.json`,
      );
      const manifest = yield* get(store, `${pointer.prefix}/manifest.json`);
      if (
        !named ||
        !manifest ||
        !deepEqual(
          yield* decode(Node.DeployPointer, yield* json(named.body)),
          pointer,
        ) ||
        !deepEqual(
          yield* decode(Node.Manifest, yield* json(manifest.body)),
          item.manifest,
        )
      )
        return yield* fail(
          "drift",
          "Published Celld graph differs from the requested graph.",
        );
      yield* snapshot(`deploy/${pointer.script_name}/current.json`, named);
      yield* snapshot(`${pointer.prefix}/manifest.json`, manifest);
    }
    const root = yield* get(store, "deploy/current.json");
    if (
      !root ||
      !deepEqual(
        yield* decode(Node.DeployPointer, yield* json(root.body)),
        graph.root.pointer,
      )
    )
      return yield* fail(
        "drift",
        "Published Celld root differs from the requested graph.",
      );
    yield* snapshot("deploy/current.json", root);
    return { graph, snapshots };
  });

const ApplicationOwner = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
  fqn: Schema.String,
  instanceId: Schema.String,
});
const PublicationLock = Schema.Struct({
  owner: ApplicationOwner,
  transactionId: Schema.String,
  fingerprint: Schema.String,
  priorRevision: Schema.optional(Schema.String),
});
const PublicationReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  owner: ApplicationOwner,
  transactionId: Schema.String,
  revision: Schema.String,
  root: Schema.toType(Node.DeployPointer),
  workers: Schema.Array(Schema.toType(Node.DeployPointer)),
  objects: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      body: Schema.String,
      etag: Schema.String,
    }),
  ),
});
const GraphMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operatorClasses: Schema.Array(Schema.String),
  revision: Schema.String,
  candidates: Schema.Array(
    Schema.Struct({ scriptName: Schema.String, key: Schema.String }),
  ),
});
const hashJson = (value: unknown) =>
  Effect.try({
    try: () => createHash("sha256").update(canonicalJson(value)).digest("hex"),
    catch: () =>
      new FleetManagementError({
        reason: "configuration",
        message: "Invalid Celld publication identity.",
      }),
  });

/** Exact bytes remain private; returned evidence contains only their digests. */
const checkActivation = (store: Store, value: ManagementGraph) =>
  Effect.gen(function* () {
    const graph = yield* decode(ManagementGraph, value);
    const snapshots: {
      key: string;
      etag: string;
      body: Uint8Array;
      sha256: string;
    }[] = [];
    const observe = (key: string) =>
      Effect.gen(function* () {
        const object = yield* get(store, key);
        if (!object || !object.etag)
          return yield* fail(
            "drift",
            "Required locked Celld publication input is missing.",
          );
        yield* Effect.sync(() =>
          snapshots.push({
            key,
            etag: object.etag,
            body: object.body.slice(),
            sha256: createHash("sha256").update(object.body).digest("hex"),
          }),
        );
        return object;
      });
    const lock = yield* decode(
      PublicationLock,
      yield* json((yield* observe(APPLICATION_LOCK_KEY)).body),
    );
    const receipt = yield* decode(
      PublicationReceipt,
      yield* json((yield* observe(APPLICATION_RECEIPT_KEY)).body),
    );
    const all = [graph.root, ...graph.workers];
    if (
      all.length > 128 ||
      new Set(all.map((item) => item.pointer.script_name)).size !==
        all.length ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(lock.transactionId) ||
      !/^[a-f0-9]{64}$/.test(lock.fingerprint) ||
      (lock.priorRevision !== undefined &&
        !/^[a-f0-9]{64}$/.test(lock.priorRevision)) ||
      Object.values(lock.owner).some((field) => !field) ||
      !deepEqual(lock.owner, receipt.owner) ||
      lock.transactionId !== receipt.transactionId ||
      !deepEqual(receipt.root, graph.root.pointer) ||
      !deepEqual(
        receipt.workers,
        graph.workers.map((worker) => worker.pointer),
      ) ||
      receipt.revision !==
        (yield* hashJson({
          fingerprint: lock.fingerprint,
          transactionId: lock.transactionId,
        }))
    )
      return yield* fail(
        "drift",
        "Celld publisher lock and current receipt do not match the requested graph.",
      );
    const fingerprint = (adopt: boolean) =>
      hashJson({
        owner: lock.owner,
        root: graph.root.pointer,
        manifests: all.map((item) => item.manifest),
        priorRevision: lock.priorRevision ?? null,
        adopt,
      });
    if (
      lock.fingerprint !== (yield* fingerprint(false)) &&
      lock.fingerprint !== (yield* fingerprint(true))
    )
      return yield* fail(
        "drift",
        "Celld publisher lock does not identify the requested manifests.",
      );

    const metadata = yield* decode(
      Schema.Record(Schema.String, Schema.Unknown),
      graph.root.manifest.raw_metadata,
    );
    const marker = yield* decode(
      GraphMarker,
      metadata[APPLICATION_GRAPH_METADATA],
    );
    const ordered = [
      graph.root,
      ...[...graph.workers].sort((a, b) =>
        a.manifest.script_name.localeCompare(b.manifest.script_name),
      ),
    ];
    if (
      !deepEqual(marker.operatorClasses, APPLICATION_OPERATOR_CLASSES) ||
      marker.revision !== (yield* hashJson(marker.candidates)) ||
      marker.candidates.length !== ordered.length ||
      marker.candidates.some(
        (candidate, index) =>
          candidate.scriptName !== ordered[index]?.pointer.script_name,
      )
    )
      return yield* fail(
        "configuration",
        "Invalid or incomplete Celld Application graph marker.",
      );
    for (const [index, candidate] of marker.candidates.entries()) {
      const match =
        /^alchemy\/deployments\/v1\/candidates\/([a-z0-9-]+)\/([a-f0-9]{16})\/([a-f0-9]{64})\.json$/.exec(
          candidate.key,
        );
      if (!match || match[1] !== candidate.scriptName)
        return yield* fail(
          "configuration",
          "Invalid Celld Application source candidate key.",
        );
      const object = yield* observe(candidate.key);
      const source = yield* decode(Node.Manifest, yield* json(object.body));
      const digest = yield* Effect.sync(() =>
        createHash("sha256").update(object.body).digest("hex"),
      );
      if (
        match[2] !== source.version ||
        match[3] !== digest ||
        source.script_name !== candidate.scriptName
      )
        return yield* fail(
          "drift",
          "Celld source candidate identity does not match its content.",
        );
      let expected = source;
      let actual = ordered[index]!.manifest;
      if (index === 0) {
        const sourceMetadata = yield* decode(
          Schema.Record(Schema.String, Schema.Unknown),
          source.raw_metadata,
        );
        const sourceBindings = yield* decode(
          Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
          sourceMetadata.bindings ?? [],
        );
        if (
          sourceMetadata[APPLICATION_GRAPH_METADATA] !== undefined ||
          sourceBindings.some(
            (binding) =>
              typeof binding.name === "string" &&
              binding.name.startsWith(APPLICATION_GRAPH_BINDING_PREFIX),
          )
        )
          return yield* fail(
            "configuration",
            "Celld source candidate uses reserved Application graph metadata.",
          );
        // Class and feature ordering is immaterial; duplicates or extra entries still fail.
        actual = {
          ...actual,
          do_classes: [...actual.do_classes].sort(),
          sqlite_classes: [...actual.sqlite_classes].sort(),
          required_features: [...(actual.required_features ?? [])].sort(),
        };
        expected = {
          ...source,
          do_classes: [
            ...new Set([...source.do_classes, ...APPLICATION_OPERATOR_CLASSES]),
          ].sort(),
          sqlite_classes: [
            ...new Set([
              ...source.sqlite_classes,
              ...APPLICATION_OPERATOR_CLASSES,
            ]),
          ].sort(),
          required_features: [
            ...new Set([
              ...(source.required_features ?? []),
              ...APPLICATION_OPERATOR_FEATURES,
            ]),
          ].sort(),
          version: graph.root.pointer.version,
          raw_metadata: {
            ...sourceMetadata,
            [APPLICATION_GRAPH_METADATA]: marker,
            bindings: [
              ...sourceBindings,
              ...ordered.slice(1).map((worker, workerIndex) => ({
                type: "service",
                name: `${APPLICATION_GRAPH_BINDING_PREFIX}${workerIndex}`,
                service: worker.pointer.script_name,
              })),
            ],
          },
        };
      }
      if (!deepEqual(expected, actual))
        return yield* fail(
          "drift",
          "Celld graph differs from its source candidate manifests or native service bindings.",
        );
    }

    const records = new Map(
      receipt.objects.map((object) => [object.key, object]),
    );
    if (records.size !== receipt.objects.length || records.size > 4096)
      return yield* fail(
        "configuration",
        "Invalid Celld publication receipt inventory.",
      );
    const required = [
      "deploy/current.json",
      ...all.flatMap((item) => [
        `deploy/${item.pointer.script_name}/current.json`,
        `${item.pointer.prefix}/manifest.json`,
        ...(item.manifest.queue_consumers ?? []).map(
          (consumer) => `deploy/queues/${consumer.queue}/consumer.json`,
        ),
      ]),
    ];
    if (required.some((key) => !records.has(key)))
      return yield* fail(
        "drift",
        "Celld current receipt is missing requested graph entries.",
      );
    for (const record of receipt.objects) {
      if (
        (!record.key.startsWith("deploy/") &&
          !/^alchemy\/deployments\/v1\/candidates\/[a-z0-9-]+\/[a-f0-9]{16}\/[a-f0-9]{64}\.json\.artifacts\.json$/.test(
            record.key,
          )) ||
        record.key
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        return yield* fail(
          "configuration",
          "Invalid Celld publication receipt object key.",
        );
      const observed = yield* observe(record.key);
      const matches = yield* Effect.sync(() => {
        const expected = new TextEncoder().encode(record.body);
        return (
          observed.etag === record.etag &&
          expected.length === observed.body.length &&
          expected.every((byte, index) => byte === observed.body[index])
        );
      });
      if (!matches)
        return yield* fail(
          "drift",
          "Celld current publication receipt no longer matches storage.",
        );
    }
    return {
      graph,
      snapshots,
      graphRevision: marker.revision,
      publicationRevision: receipt.revision,
    };
  });

const assertLiveSession = (
  store: Store,
  node: LiveManagementNode,
  options: ManagementOptions,
) =>
  Effect.gen(function* () {
    const object = yield* get(store, `nodes/${node.session}.json`);
    if (!object)
      return yield* fail(
        "membership-changed",
        "A Celld node session disappeared before management.",
      );
    const lease = yield* decode(Lease, yield* json(object.body));
    const now = yield* Clock.currentTimeMillis;
    if (
      lease.node !== node.session ||
      !Number.isSafeInteger(lease.expires_ms) ||
      lease.expires_ms <= now ||
      lease.peer_protocol !== 5 ||
      (yield* privateNodeEndpoint(lease.addr, options.internalPort)) !==
        node.endpoint
    ) {
      return yield* fail(
        "membership-changed",
        "A Celld node session changed before management.",
      );
    }
  });

/**
 * Bracket one forced reload per live node with graph storage observations.
 * Only GET state is repeated (at most ten reads, 500 ms apart). Native v0.5
 * acknowledges graph build and adoption before replying `adopted`, not cron arming.
 * These snapshots are not an atomic publication fence or named-adoption proof.
 */
export const proveRootReload = (
  store: Store,
  httpClient: HttpClient.HttpClient,
  value: ManagementGraph,
  options: ManagementOptions = {},
): Effect.Effect<RootReloadProof, FleetManagementError> =>
  Effect.gen(function* () {
    const before = yield* checkGraph(store, value);
    const expected = before.graph.root.pointer;
    const nodes = yield* discoverManagementNodes(store, options);
    yield* loadPeerKey(store);
    const observations = yield* Effect.forEach(
      nodes,
      (node) =>
        Effect.gen(function* () {
          const services = Layer.mergeAll(
            Layer.succeed(Endpoint, node.endpoint),
            Layer.succeed(HttpClient.HttpClient, httpClient),
            Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
          );
          yield* assertLiveSession(store, node, options);
          const reloaded = yield* Node.reloadDeployment({}).pipe(
            Effect.catchTag("ReloadFailed", () =>
              fail(
                "reload-failed",
                "Celld refused the forced root reload; the prior generation remains active.",
              ),
            ),
            Effect.timeout("10 seconds"),
            Effect.mapError((error) =>
              error instanceof FleetManagementError
                ? error
                : new FleetManagementError({
                    reason: "transport",
                    message:
                      "Forced Celld reload failed without an adoption acknowledgement; observe state before retrying.",
                  }),
            ),
            Effect.provide(services),
          );
          if (
            !reloaded.ok ||
            reloaded.outcome !== "adopted" ||
            !Number.isSafeInteger(reloaded.generation) ||
            reloaded.generation < 1
          ) {
            return yield* fail(
              "reload-failed",
              "Celld did not acknowledge a forced root adoption.",
            );
          }
          if (
            reloaded.version !== expected.version ||
            reloaded.prefix !== expected.prefix
          ) {
            return yield* fail(
              "drift",
              "Celld acknowledged a different root deployment.",
            );
          }
          let stateReads = 0;
          const deployment = yield* Effect.gen(function* () {
            yield* assertLiveSession(store, node, options);
            const state = yield* Node.getNodeState({}).pipe(
              Effect.timeout("2 seconds"),
              Effect.mapError(
                () =>
                  new FleetManagementError({
                    reason: "state-unavailable",
                    message:
                      "Celld acknowledged reload, but its node state could not be observed.",
                  }),
              ),
              Effect.provide(services),
            );
            stateReads++;
            if (
              state.error ||
              !state.deployment ||
              !Number.isSafeInteger(state.deployment.swapping) ||
              state.deployment.swapping < 0
            ) {
              return yield* fail(
                "state-unavailable",
                "Celld acknowledged reload, but its actor has no valid deployment state.",
              );
            }
            if (
              state.deployment.version !== expected.version ||
              state.deployment.prefix !== expected.prefix ||
              state.deployment.generation !== reloaded.generation
            ) {
              return yield* fail(
                "drift",
                "Celld node state differs from its acknowledged root generation.",
              );
            }
            return state.deployment;
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              times: 9,
              until: (state) => state.swapping === 0,
            }),
          );
          if (deployment.swapping !== 0) {
            return yield* fail(
              "swap-pending",
              "Celld acknowledged root adoption, but cell swaps remained pending after ten state observations.",
            );
          }
          return {
            session: node.session,
            endpoint: node.endpoint,
            outcome: "adopted" as const,
            generation: deployment.generation,
            version: deployment.version,
            prefix: deployment.prefix,
            stateReads,
          };
        }),
      { concurrency: 4 },
    );
    if (!deepEqual(yield* discoverManagementNodes(store, options), nodes)) {
      return yield* fail(
        "membership-changed",
        "Celld membership changed during forced reload; root evidence is incomplete.",
      );
    }
    const after = yield* checkGraph(store, before.graph);
    if (!deepEqual(before.snapshots, after.snapshots)) {
      return yield* fail(
        "drift",
        "Celld graph storage snapshots changed during forced reload.",
      );
    }
    return {
      assurance: "forced-root-reload" as const,
      namedAdoption: "not-observed" as const,
      root: expected,
      snapshots: before.snapshots,
      nodes: observations,
    };
  }).pipe(
    Effect.timeout("55 seconds"),
    Effect.mapError((error) =>
      error instanceof FleetManagementError
        ? error
        : new FleetManagementError({
            reason: "transport",
            message:
              "Celld root observation timed out; reload outcome may be ambiguous.",
          }),
    ),
  );

/** Private-network implementation. Supply a no-redirect, non-retrying HTTP client. */
export const makeLocalFleetManagement = (
  storage: FleetStorage["Service"],
  httpClient: HttpClient.HttpClient,
  options: ManagementOptions = {},
): FleetManagementService => {
  const open = (connection: FleetConnection) =>
    storage(connection).pipe(
      Effect.mapError(
        () =>
          new FleetManagementError({
            reason: "transport",
            message: "Cannot open the private Celld backing store.",
          }),
      ),
    );
  const reload: FleetManagementService["reload"] = (connection, value) =>
    Effect.gen(function* () {
      const store = yield* open(connection);
      const proof = yield* proveRootReload(store, httpClient, value, options);
      return {
        assurance: "root-identity-only" as const,
        nodes: proof.nodes.map(({ session, generation, version, prefix }) => ({
          session,
          generation,
          version,
          prefix,
        })),
        proof,
      };
    }).pipe(
      Effect.timeout("55 seconds"),
      Effect.mapError((error) =>
        error instanceof FleetManagementError
          ? error
          : new FleetManagementError({
              reason: "transport",
              message:
                "Celld management timed out; reload outcome may be ambiguous.",
            }),
      ),
    );
  const operator = Effect.fn(function* (connection: FleetConnection) {
    const store = yield* open(connection);
    const peerKey = yield* loadPeerKey(store);
    const nodes = yield* discoverManagementNodes(store, options);
    const node = nodes[0]!;
    yield* assertLiveSession(store, node, options);
    return makeLocalFleetOperator({
      endpoint: node.endpoint,
      target: node.session,
      source: "alchemy-management",
      peerKey,
      httpClient,
    });
  });
  const guarded = <A>(
    effect: Effect.Effect<A, OperatorError | FleetManagementError>,
  ) =>
    effect.pipe(
      Effect.timeout("60 seconds"),
      Effect.mapError(
        () =>
          new OperatorError({
            message:
              "Private Celld D1 operation failed; inspect durable state before retrying a mutation.",
          }),
      ),
      Effect.provide(
        Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
      ),
    );
  return {
    reload,
    activate: (connection, graph) =>
      Effect.gen(function* () {
        const store = yield* open(connection);
        const before = yield* checkActivation(store, graph);
        const proof = yield* proveRootReload(
          store,
          httpClient,
          before.graph,
          options,
        );
        const after = yield* checkActivation(store, before.graph);
        const unchanged =
          before.snapshots.length === after.snapshots.length &&
          before.snapshots.every((snapshot, index) => {
            const current = after.snapshots[index]!;
            return (
              snapshot.key === current.key &&
              snapshot.etag === current.etag &&
              snapshot.body.length === current.body.length &&
              snapshot.body.every((byte, i) => byte === current.body[i])
            );
          });
        if (!unchanged)
          return yield* fail(
            "drift",
            "Celld locked publication inputs changed during graph activation.",
          );
        const snapshots = new Map(
          proof.snapshots.map((snapshot) => [snapshot.key, snapshot]),
        );
        for (const { key, etag, sha256 } of before.snapshots)
          snapshots.set(key, { key, etag, sha256 });
        return {
          assurance: "locked-graph-generation" as const,
          cronDelivery: "not-observed" as const,
          graphRevision: before.graphRevision,
          publicationRevision: before.publicationRevision,
          proof: { ...proof, snapshots: [...snapshots.values()] },
        };
      }).pipe(
        Effect.timeout("55 seconds"),
        Effect.mapError((error) =>
          error instanceof FleetManagementError
            ? error
            : new FleetManagementError({
                reason: "transport",
                message:
                  "Celld graph activation timed out; generation outcome may be ambiguous.",
              }),
        ),
      ),
    operator: {
      execD1: (connection, input) =>
        guarded(
          operator(connection).pipe(
            Effect.flatMap((client) => client.execD1(connection, input)),
          ),
        ),
      executeD1Statements: (connection, input) =>
        guarded(
          operator(connection).pipe(
            Effect.flatMap((client) =>
              client.executeD1Statements(connection, input),
            ),
          ),
        ),
      migrateD1: (connection, input) =>
        guarded(
          operator(connection).pipe(
            Effect.flatMap((client) => client.migrateD1(connection, input)),
          ),
        ),
    },
  };
};

/** Adapt private management to the D1 deployment-time transport contract. */
export const FleetOperatorManagement = Layer.effect(
  FleetOperator,
  Effect.map(FleetManagement, (management) => management.operator),
);

export const FleetManagementLocal = (options: ManagementOptions = {}) =>
  Layer.effect(
    FleetManagement,
    Effect.gen(function* () {
      return makeLocalFleetManagement(
        yield* FleetStorage,
        yield* HttpClient.HttpClient,
        options,
      );
    }),
  );
