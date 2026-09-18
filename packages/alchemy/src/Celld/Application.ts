import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../Diff.ts";
import type { Input } from "../Input.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  publishApplication,
  readPublicationReceipt,
  readPublicationRecovery,
  readPublicationTransaction,
  type ApplicationOwner,
  type PreparedDeployment,
  type PublicationReceipt,
} from "./Deployment.ts";
import {
  bytes,
  digest,
  encode,
  equalBytes,
  refuse,
  DeploymentError,
} from "./Deployment/Objects.ts";
import {
  CurrentFleet,
  type FleetResourceProps,
  type FleetResourceAttributes,
} from "./FleetContext.ts";
import { FleetStorage, type Store } from "./FleetStorage.ts";
import { catalogOwner, fleetConnection } from "./ResourceCatalog.ts";
import type { Providers } from "./Providers.ts";
import { readStagedDeployment } from "./StagedDeployment.ts";
import type { CelldWorker } from "./Worker.ts";
import { prepareApplicationGraph } from "./ApplicationGraph.ts";

export interface ApplicationWorker {
  readonly workerName: string;
  readonly fleetId: string;
  readonly stagedManifestKey: string;
  readonly exposed: boolean;
  readonly url: string;
}
export interface ApplicationResourceProps extends FleetResourceProps {
  /** Staged root Worker. @internal */
  readonly entrypoint: ApplicationWorker;
  /** Staged service and queue-consumer Workers. @internal */
  readonly workers: readonly ApplicationWorker[];
}
export interface ApplicationProps<R = never> {
  /** The only Worker served by the fleet's HTTP listener. */
  readonly entrypoint: Effect.Effect<CelldWorker, never, R>;
  /** All other Workers used by service bindings or queue consumers. */
  readonly workers?: readonly Effect.Effect<CelldWorker, never, R>[];
}
export interface ApplicationAttributes extends FleetResourceAttributes {
  /** Reachable entrypoint URL, returned only after activation succeeds. */
  readonly url: string;
  /** Native entrypoint script identity. */
  readonly workerName: string;
  /** Durable publication identity, including changes to secondary Workers and cron. */
  readonly revision: string;
  /** Exact candidate identities selected by this publication. */
  readonly candidates: readonly string[];
}
export interface Application extends Resource<
  "Celld.Application",
  ApplicationResourceProps,
  ApplicationAttributes,
  never,
  Providers | CurrentFleet
> {}

/** Host-specific adoption verification; publishing objects alone is insufficient. */
export class ApplicationActivation extends Context.Service<
  ApplicationActivation,
  {
    readonly activate: (
      connection: FleetResourceAttributes,
      root: PreparedDeployment,
      workers: readonly PreparedDeployment[],
      revision: string,
    ) => Effect.Effect<void, DeploymentError>;
  }
>()("Celld.ApplicationActivation") {}

const ApplicationResource = Resource<Application>("Celld.Application");
const reference = (worker: CelldWorker): Input<ApplicationWorker> => ({
  workerName: worker.workerName,
  fleetId: worker.fleetId,
  stagedManifestKey: worker.stagedManifestKey,
  exposed: worker.exposed,
  url: worker.url,
});

/**
 * Exclusively publish and activate one fleet's Worker graph. Workers stage code;
 * Application owns live pointers and queue attachments. Removing this declaration
 * retains its publication and ownership; it does not destroy application data.
 *
 * ### Publishing an Application
 * **Example:** Root and background Workers in one fleet
 * ```typescript
 * const app = yield* Celld.Application("App", { entrypoint: Api, workers: [Jobs] });
 * // Provide ApiLive and JobsLive with Celld.Fleet.layer(Cells).
 * ```
 *
 * @resource
 * @product Celld
 */
export const Application = Object.assign(
  <R>(id: string, props: ApplicationProps<R>) =>
    ApplicationResource(
      id,
      Effect.gen(function* () {
        const fleet = yield* CurrentFleet;
        const entrypoint = yield* props.entrypoint;
        const workers = yield* Effect.all(props.workers ?? []);
        if (
          workers.some((worker) => worker.FQN === entrypoint.FQN) ||
          new Set(workers.map((worker) => worker.FQN)).size !== workers.length
        ) {
          return yield* Effect.die(
            new DeploymentError({
              reason: "configuration",
              message: "Application must declare each Worker exactly once.",
            }),
          );
        }
        return {
          fleetId: fleet.FQN,
          fleetUrl: fleet.fleetUrl,
          bucket: fleet.bucket,
          hostState: fleet.hostState,
          entrypoint: reference(entrypoint),
          workers: workers.map(reference),
        };
      }),
    ),
  ApplicationResource,
);

const applicationMembers = (props: ApplicationResourceProps) =>
  Effect.gen(function* () {
    const connection = yield* fleetConnection(props);
    const members = [
      props.entrypoint,
      ...[...props.workers].sort((a, b) =>
        a.workerName < b.workerName ? -1 : a.workerName > b.workerName ? 1 : 0,
      ),
    ];
    if (members.some((worker) => worker.fleetId !== connection.fleetId))
      return yield* refuse(
        "configuration",
        "All Application Workers must belong to the selected fleet.",
      );
    if (props.workers.some((worker) => worker.exposed))
      return yield* refuse(
        "configuration",
        "Only the Application entrypoint can request public ingress.",
      );
    if (
      new Set(members.map((worker) => worker.workerName)).size !==
        members.length ||
      new Set(members.map((worker) => worker.stagedManifestKey)).size !==
        members.length
    )
      return yield* refuse(
        "configuration",
        "Application must declare each Worker exactly once.",
      );
    return { connection, members };
  });

const prepareMembers = (store: Store, members: readonly ApplicationWorker[]) =>
  Effect.gen(function* () {
    const sources = yield* Effect.forEach(members, (member) =>
      Effect.gen(function* () {
        const deployment = yield* readStagedDeployment(
          store,
          member.stagedManifestKey,
        );
        if (member.workerName !== deployment.scriptName)
          return yield* refuse(
            "configuration",
            "Application Worker name disagrees with its staged candidate.",
          );
        return deployment;
      }),
    );
    const graph = yield* prepareApplicationGraph(sources[0]!, sources.slice(1));
    return {
      prepared: [graph.root, ...graph.workers],
      candidates: [sources[0]!, ...graph.workers].map(
        (source) => source.candidate.key,
      ),
    };
  });

const matchesPublication = (
  receipt: PublicationReceipt | undefined,
  prepared: readonly PreparedDeployment[],
) =>
  Effect.gen(function* () {
    if (
      !receipt ||
      !deepEqual(receipt.root, prepared[0]!.pointer) ||
      !deepEqual(
        receipt.workers,
        prepared.slice(1).map((worker) => worker.pointer),
      )
    )
      return false;
    for (const deployment of prepared) {
      const published = receipt.objects.find(
        (object) => object.key === `${deployment.prefix}/manifest.json`,
      );
      if (
        !published ||
        !(yield* equalBytes(
          yield* bytes(published.body),
          deployment.candidate.body,
        ))
      )
        return false;
    }
    return true;
  });

const publishMembers = (
  store: Store,
  owner: ApplicationOwner,
  connection: FleetResourceAttributes,
  props: ApplicationResourceProps,
  graph: Effect.Success<ReturnType<typeof prepareMembers>>,
  receipt: PublicationReceipt | undefined,
  recovery: Effect.Success<ReturnType<typeof readPublicationRecovery>>,
  note: (message: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const { prepared, candidates } = graph;
    const operation =
      recovery ??
      (receipt && (yield* matchesPublication(receipt, prepared))
        ? yield* readPublicationTransaction(store, receipt)
        : undefined);
    const priorRevision = operation
      ? operation.priorRevision
      : receipt?.revision;
    const transactionId = yield* digest(
      yield* encode({
        owner,
        candidates,
        priorRevision: priorRevision ?? null,
      }),
    );
    if (operation && transactionId !== operation.transactionId)
      return yield* refuse(
        "locked",
        "The Application transaction has different source candidates; resume its exact graph before publishing a different one.",
      );
    const activation = yield* ApplicationActivation;
    yield* note("publishing Application graph");
    const published = yield* publishApplication(
      store,
      {
        rootPreparedDeployment: prepared[0]!,
        workers: prepared.slice(1),
        owner,
        transactionId,
        priorRevision,
      },
      (publication) =>
        Effect.gen(function* () {
          yield* note("verifying fleet adoption under publisher lock");
          yield* activation.activate(
            connection,
            prepared[0]!,
            prepared.slice(1),
            publication.revision,
          );
        }),
    );
    return {
      ...connection,
      url: props.entrypoint.url,
      workerName: prepared[0]!.scriptName,
      revision: published.revision,
      candidates,
    } satisfies ApplicationAttributes;
  });

/** Observe a current publication and verify activation; saved output is never readiness evidence. @internal */
export const readApplication = (
  props: ApplicationResourceProps,
  owner: ApplicationOwner,
) =>
  Effect.gen(function* () {
    // An interrupted dependency create can leave a row that never had publication inputs.
    if (
      !isResolved(props) ||
      !props.fleetId ||
      !props.fleetUrl ||
      !props.bucket?.uri
    )
      return undefined;
    const { connection, members } = yield* applicationMembers(props);
    const storage = yield* FleetStorage;
    const store = yield* storage(connection);
    const receipt = yield* readPublicationReceipt(store);
    if (receipt && !deepEqual(receipt.owner, owner))
      return yield* refuse(
        "ownership",
        "Application publication belongs to another owner.",
      );
    const recovery = yield* readPublicationRecovery(store, owner);
    if (!receipt) return undefined;
    if (recovery && recovery.transactionId !== receipt.transactionId)
      return undefined;
    const graph = yield* prepareMembers(store, members);
    if (!(yield* matchesPublication(receipt, graph.prepared))) return undefined;
    return yield* publishMembers(
      store,
      owner,
      connection,
      props,
      graph,
      receipt,
      recovery,
      () => Effect.void,
    );
  });

/** Resume owned publication before checking old receipt ETags, then activate even on a graph no-op. @internal */
export const reconcileApplication = (
  props: ApplicationResourceProps,
  owner: ApplicationOwner,
  note: (message: string) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const { connection, members } = yield* applicationMembers(props);
    const storage = yield* FleetStorage;
    const store = yield* storage(connection);
    const graph = yield* prepareMembers(store, members);
    const receipt = yield* readPublicationReceipt(store);
    if (receipt && !deepEqual(receipt.owner, owner))
      return yield* refuse(
        "ownership",
        "Application publication belongs to another owner.",
      );
    const recovery = yield* readPublicationRecovery(store, owner);
    return yield* publishMembers(
      store,
      owner,
      connection,
      props,
      graph,
      receipt,
      recovery,
      note,
    );
  });

export const ApplicationProvider = () =>
  Provider.succeed(ApplicationResource, {
    diff: Effect.fn(function* ({ news, olds }) {
      if (
        isResolved(news) &&
        (news.fleetId !== olds.fleetId || !deepEqual(news.bucket, olds.bucket))
      )
        return { action: "replace" } as const;
    }),
    read: Effect.fn(function* ({ olds, fqn, instanceId }) {
      return yield* readApplication(olds, yield* catalogOwner(fqn, instanceId));
    }),
    reconcile: Effect.fn(function* ({ news, fqn, instanceId, session }) {
      return yield* reconcileApplication(
        news,
        yield* catalogOwner(fqn, instanceId),
        session.note,
      );
    }),
    delete: () => Effect.void,
  });
