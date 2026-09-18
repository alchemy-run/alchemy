import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import * as Node from "@distilled.cloud/celld/node";
import { prepareApplicationGraph } from "@/Celld/ApplicationGraph.ts";
import {
  readApplication,
  reconcileApplication,
  type ApplicationResourceProps,
} from "@/Celld/Application.ts";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { ManagementBindings } from "@/Celld/ManagementBindings.ts";
import {
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
  publishApplication,
  readPublicationReceipt,
  readPublicationRecovery,
  stageDeployment,
} from "@/Celld/Deployment.ts";
import { makeS3Store } from "@/Celld/FleetStorageS3.ts";
import { digest, encode } from "@/Celld/Deployment/Objects.ts";
import {
  discoverManagementNodes,
  FleetManagement,
  makeLocalFleetManagement,
  type ActivateEvidence,
} from "@/Celld/Management.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  activationConnection,
  activationCredentials,
  activationMappedEndpoint,
  activationOwner,
  activationPrivateEndpoint,
  activationPublicEndpoint,
  prepareActivationSources,
} from "./fixtures/activation-live.ts";

const enabled = process.env.CELLD_ACTIVATION_LIVE === "1";

test.skipIf(!enabled)(
  "real native generations adopt secondary and cron graph changes while publication remains locked",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const store = yield* makeS3Store(
          activationConnection.bucket,
          activationCredentials,
          http,
        );
        // Docker-private discovery stays intact; only this fixture's transport crosses the host port.
        const native = http.pipe(
          HttpClient.mapRequest((request) =>
            request.url.startsWith(`${activationPrivateEndpoint}/`)
              ? HttpClientRequest.setUrl(
                  request,
                  request.url.replace(
                    activationPrivateEndpoint,
                    activationMappedEndpoint,
                  ),
                )
              : request,
          ),
        );
        const management = makeLocalFleetManagement(
          () => Effect.succeed(store),
          native,
          { minimumNodes: 1, maximumNodes: 1 },
        );
        const sessions = yield* discoverManagementNodes(store, {
          minimumNodes: 1,
          maximumNodes: 1,
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
            while: (error) =>
              error.reason === "configuration" || error.reason === "discovery",
          }),
        );
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.endpoint).toBe(activationPrivateEndpoint);
        const initial = yield* Node.getNodeState({});
        let generation = initial.deployment?.generation ?? 0;
        const observations: {
          sourceVersion: string;
          rootVersion: string;
          graphRevision: string;
          generation: number;
          body: string;
        }[] = [];
        for (const step of [
          { secondary: "one", cron: "0 0 * * *" },
          { secondary: "two", cron: "0 0 * * *" },
          { secondary: "two", cron: "30 0 * * *" },
        ] as const) {
          const source = yield* prepareActivationSources(
            step.secondary,
            step.cron,
          );
          yield* stageDeployment(store, source.root);
          yield* stageDeployment(store, source.worker);
          const graph = yield* prepareApplicationGraph(source.root, [
            source.worker,
          ]);
          const previous = yield* readPublicationReceipt(store);
          expect(previous?.owner).toEqual(activationOwner);
          const recovery = yield* readPublicationRecovery(
            store,
            activationOwner,
          );
          const activation: { evidence?: ActivateEvidence } = {};
          let callbacks = 0;
          const publication = yield* publishApplication(
            store,
            {
              rootPreparedDeployment: graph.root,
              workers: graph.workers,
              owner: activationOwner,
              transactionId:
                recovery?.transactionId ??
                (yield* digest(
                  yield* encode({
                    owner: activationOwner,
                    candidates: [
                      source.root.candidate.key,
                      source.worker.candidate.key,
                    ],
                    priorRevision: previous?.revision ?? null,
                  }),
                )),
              priorRevision: recovery
                ? recovery.priorRevision
                : previous?.revision,
            },
            (published) =>
              Effect.gen(function* () {
                expect(yield* store.get(APPLICATION_LOCK_KEY)).toBeDefined();
                expect((yield* readPublicationReceipt(store))?.revision).toBe(
                  published.revision,
                );
                activation.evidence = yield* management.activate(
                  activationConnection,
                  graph,
                );
                callbacks++;
                expect(yield* store.get(APPLICATION_LOCK_KEY)).toBeDefined();
              }),
          );
          expect(callbacks).toBe(1);
          const evidence = activation.evidence;
          if (!evidence)
            return yield* Effect.fail(
              new Error("Activation did not run under the publication lock."),
            );
          expect(evidence.assurance).toBe("locked-graph-generation");
          expect(evidence.cronDelivery).toBe("not-observed");
          expect(evidence.graphRevision).toBe(graph.revision);
          expect(evidence.publicationRevision).toBe(publication.revision);
          expect(evidence.proof.nodes).toHaveLength(1);
          expect(evidence.proof.nodes[0]?.session).toBe(sessions[0]?.session);
          expect(evidence.proof.nodes[0]?.endpoint).toBe(
            activationPrivateEndpoint,
          );
          expect(
            evidence.proof.snapshots.map((snapshot) => snapshot.key),
          ).toEqual(
            expect.arrayContaining([
              APPLICATION_LOCK_KEY,
              APPLICATION_RECEIPT_KEY,
              source.root.candidate.key,
              source.worker.candidate.key,
            ]),
          );
          expect(yield* store.get(APPLICATION_LOCK_KEY)).toBeUndefined();
          const observed = yield* Node.getNodeState({});
          expect(observed.deployment?.version).toBe(graph.root.version);
          expect(observed.deployment?.prefix).toBe(graph.root.prefix);
          expect(observed.deployment?.swapping).toBe(0);
          expect(observed.deployment?.generation).toBe(
            evidence.proof.nodes[0]?.generation,
          );
          expect(observed.deployment!.generation).toBeGreaterThan(generation);
          generation = observed.deployment!.generation;
          const response = yield* http.get(`${activationPublicEndpoint}/`);
          const body = yield* response.text;
          expect(response.status).toBe(200);
          expect(body).toBe(`activation-secondary-${step.secondary}`);
          observations.push({
            sourceVersion: source.root.version,
            rootVersion: graph.root.version,
            graphRevision: graph.revision,
            generation,
            body,
          });
          yield* Effect.log({
            transport: {
              discovered: activationPrivateEndpoint,
              mapped: activationMappedEndpoint,
            },
            publicationCallback: "publishApplication.onPublished",
            secondary: step.secondary,
            cron: step.cron,
            body,
            evidence,
          });
        }
        expect(
          new Set(observations.map((observation) => observation.sourceVersion))
            .size,
        ).toBe(1);
        expect(
          new Set(observations.map((observation) => observation.rootVersion))
            .size,
        ).toBe(3);
        expect(
          new Set(observations.map((observation) => observation.graphRevision))
            .size,
        ).toBe(3);
        expect((yield* readPublicationReceipt(store))?.owner).toEqual(
          activationOwner,
        );
        const finalSources = yield* prepareActivationSources(
          "two",
          "30 0 * * *",
        );
        const member = (deployment: typeof finalSources.root) => ({
          workerName: deployment.scriptName,
          fleetId: activationConnection.fleetId,
          stagedManifestKey: deployment.candidate.key,
          exposed: false,
          url: activationPublicEndpoint,
        });
        const props: ApplicationResourceProps = {
          ...activationConnection,
          entrypoint: member(finalSources.root),
          workers: [member(finalSources.worker)],
        };
        const prior = yield* readPublicationReceipt(store);
        yield* Effect.gen(function* () {
          const reconciled = yield* reconcileApplication(
            props,
            activationOwner,
          );
          expect(reconciled.revision).toBe(prior?.revision);
          expect(reconciled.url).toBe(activationPublicEndpoint);
          expect(reconciled.candidates).toEqual([
            finalSources.root.candidate.key,
            finalSources.worker.candidate.key,
          ]);
          const refreshed = yield* readApplication(props, activationOwner);
          expect(refreshed).toEqual(reconciled);
          expect(yield* store.get(APPLICATION_LOCK_KEY)).toBeUndefined();
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ManagementBindings,
              Layer.succeed(FleetStorage, () => Effect.succeed(store)),
              Layer.succeed(FleetManagement, management),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Layer.succeed(Endpoint, activationMappedEndpoint),
          ),
        ),
        Effect.timeout("115 seconds"),
      ),
    ),
  { timeout: 120_000 },
);
