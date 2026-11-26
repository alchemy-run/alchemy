import * as AWS from "@alchemy.run/aws";
import {
  Campaign,
  DecoderManifest,
  Fleet,
  ModelManifest,
  SignalCatalog,
  StateTemplate,
  Vehicle,
} from "@alchemy.run/aws/IoTFleetWise";
import { Bucket } from "@alchemy.run/aws/S3";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import FleetWiseBindingsFunctionLive, { FleetWiseBindingsFunction } from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// AWS IoT FleetWise is allowlist-gated — accounts without service access
// observe AccessDeniedException on every operation. The live Lambda E2E
// needs real FleetWise resources, so it is gated behind
// AWS_TEST_IOTFLEETWISE=1 for allowlisted accounts.
const RUN_LIVE = !!process.env.AWS_TEST_IOTFLEETWISE;

// FleetWise is offered in us-east-1/eu-central-1 only — pin every
// out-of-band distilled call to the service's home region.
const inHomeRegion = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(Region, Effect.succeed("us-east-1")));

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on decode on every account, allowlisted or not, at near-zero cost.
test.provider(
  "getVehicleStatus on a nonexistent vehicle fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .getVehicleStatus({ vehicleName: "alchemy-nonexistent-vehicle-probe" })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:iotfleetwise", "live"] },
);

test.provider(
  "listVehiclesInFleet on a nonexistent fleet fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .listVehiclesInFleet({ fleetId: "alchemy-nonexistent-fleet-probe" })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:iotfleetwise", "live"] },
);

// Deterministic bucket name (constant per test suite — never Date.now())
// so the FleetWise bucket policy can reference the ARN as a literal.
const TELEMETRY_BUCKET = "alchemy-test-iotfleetwise-telemetry";

// Typed wait-until-gone for the gated lifecycle teardown.
const assertCatalogGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* iotfleetwise.getSignalCatalog({ name }).pipe(
      inHomeRegion,
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
    );
    if (found !== undefined) {
      return yield* Effect.fail(new Error(`signal catalog '${name}' still exists`));
    }
  }).pipe(
    Effect.retry({ schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(12)]) }),
  );

const sharedStack = Core.scratchStack(testOptions, "FleetWiseBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

// IoT FleetWise allows one signal catalog in each account and Region, and
// both the lifecycle test and the bindings fixture need one. They run in
// this order, one at a time: the lifecycle test destroys its catalog before
// the fixture deploys its own.
describe.sequential(
  "IoTFleetWise signal catalog",
  { tags: ["provider:aws", "provider:aws:iotfleetwise", "live"] },
  () => {
    // Full lifecycle across all six resources. AWS IoT FleetWise requires the
    // account to be allowlisted for the service (and registered via
    // RegisterAccount for legacy Timestream destinations) — the standing test
    // account is not, so the live run is gated behind AWS_TEST_IOTFLEETWISE=1.
    // All six resources are free and provision in seconds once entitled.
    test.provider.skipIf(!process.env.AWS_TEST_IOTFLEETWISE)(
      "signal catalog -> model -> decoder -> fleet -> vehicle -> campaign lifecycle",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const catalog = yield* SignalCatalog("Signals", {
                description: "alchemy fleetwise test signals",
                nodes: [
                  { branch: { fullyQualifiedName: "Vehicle" } },
                  {
                    sensor: {
                      fullyQualifiedName: "Vehicle.Speed",
                      dataType: "DOUBLE",
                      unit: "km/h",
                    },
                  },
                  { attribute: { fullyQualifiedName: "Vehicle.VIN", dataType: "STRING" } },
                ],
                tags: { fixture: "iotfleetwise" },
              });

              const model = yield* ModelManifest("SedanModel", {
                signalCatalogArn: catalog.signalCatalogArn,
                nodes: ["Vehicle.Speed", "Vehicle.VIN"],
                description: "alchemy fleetwise test model",
                status: "ACTIVE",
              });

              const decoder = yield* DecoderManifest("SedanDecoder", {
                modelManifestArn: model.modelManifestArn,
                description: "alchemy fleetwise test decoder",
                networkInterfaces: [
                  {
                    interfaceId: "obd0",
                    type: "OBD_INTERFACE",
                    obdInterface: { name: "obd", requestMessageId: 2015 },
                  },
                ],
                signalDecoders: [
                  {
                    fullyQualifiedName: "Vehicle.Speed",
                    type: "OBD_SIGNAL",
                    interfaceId: "obd0",
                    obdSignal: {
                      pidResponseLength: 1,
                      serviceMode: 1,
                      pid: 13,
                      scaling: 1,
                      offset: 0,
                      startByte: 0,
                      byteLength: 1,
                    },
                  },
                ],
                status: "ACTIVE",
              });

              const fleet = yield* Fleet("TestFleet", {
                signalCatalogArn: catalog.signalCatalogArn,
                description: "alchemy fleetwise test fleet",
              });

              const vehicle = yield* Vehicle("TestVehicle", {
                modelManifestArn: model.modelManifestArn,
                decoderManifestArn: decoder.decoderManifestArn,
                attributes: { "Vehicle.VIN": "1HGBH41JXMN109186" },
              });

              const stateTemplate = yield* StateTemplate("SpeedState", {
                signalCatalogArn: catalog.signalCatalogArn,
                stateTemplateProperties: ["Vehicle.Speed"],
                description: "alchemy fleetwise test state template",
              });

              // Campaign data lands in S3; FleetWise writes require a bucket
              // policy trusting the service principal. Deterministic name so
              // the policy can reference the bucket ARN as a literal.
              const bucket = yield* Bucket("TelemetryBucket", {
                bucketName: TELEMETRY_BUCKET,
                forceDestroy: true,
                policy: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "iotfleetwise.amazonaws.com" },
                    Action: ["s3:GetBucketLocation", "s3:PutObject"],
                    Resource: [
                      `arn:aws:s3:::${TELEMETRY_BUCKET}`,
                      `arn:aws:s3:::${TELEMETRY_BUCKET}/*`,
                    ],
                  },
                ],
              });

              const campaign = yield* Campaign("SpeedTelemetry", {
                signalCatalogArn: catalog.signalCatalogArn,
                targetArn: fleet.fleetArn,
                collectionScheme: { timeBasedCollectionScheme: { period: "10 seconds" } },
                signalsToCollect: [{ name: "Vehicle.Speed" }],
                dataDestinationConfigs: [{ s3Config: { bucketArn: bucket.bucketArn } }],
              });

              return { catalog, model, decoder, fleet, vehicle, stateTemplate, campaign };
            }),
          );

          expect(deployed.catalog.signalCatalogArn).toContain(":signal-catalog/");
          expect(deployed.stateTemplate.stateTemplateArn).toContain(":state-template/");
          expect(deployed.stateTemplate.stateTemplateProperties).toEqual(["Vehicle.Speed"]);
          expect(deployed.model.status).toBe("ACTIVE");
          expect(deployed.decoder.status).toBe("ACTIVE");
          expect(deployed.fleet.fleetArn).toContain(":fleet/");
          expect(deployed.vehicle.vehicleArn).toContain(":vehicle/");
          expect(deployed.campaign.status).toBe("WAITING_FOR_APPROVAL");

          // Out-of-band verification via distilled.
          const observedModel = yield* iotfleetwise
            .getModelManifest({ name: deployed.model.modelManifestName })
            .pipe(inHomeRegion);
          expect(observedModel.status).toBe("ACTIVE");
          const observedVehicle = yield* iotfleetwise
            .getVehicle({ vehicleName: deployed.vehicle.vehicleName })
            .pipe(inHomeRegion);
          expect(observedVehicle.attributes?.["Vehicle.VIN"]).toBe("1HGBH41JXMN109186");

          yield* stack.destroy();
          yield* assertCatalogGone(deployed.catalog.signalCatalogName);
        }),
      {
        tags: ["provider:aws", "provider:aws:iotfleetwise", "provider:aws:s3", "live"],
        timeout: 600_000,
      },
    );

    describe(
      "IoTFleetWise Bindings (E2E)",
      {
        tags: [
          "provider:aws",
          "provider:aws:batch",
          "provider:aws:iotfleetwise",
          "provider:aws:lambda",
          "provider:aws:s3",
          "live",
        ],
      },
      () => {
        beforeAll(
          Effect.gen(function* () {
            if (!RUN_LIVE) return;
            yield* Effect.logInfo("FleetWise E2E setup: destroying previous run");
            yield* sharedStack.destroy();

            yield* Effect.logInfo("FleetWise E2E setup: deploying resources + Lambda");
            const { functionUrl } = yield* sharedStack.deploy(
              Effect.gen(function* () {
                return yield* FleetWiseBindingsFunction;
              }).pipe(Effect.provide(FleetWiseBindingsFunctionLive)),
            );

            expect(functionUrl).toBeTruthy();
            baseUrl = functionUrl!.replace(/\/+$/, "");

            // Readiness probe — fresh function URLs take seconds to serve 200s.
            yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? Effect.succeed(response)
                  : Effect.fail(new Error(`Function not ready: ${response.status}`)),
              ),
              Effect.retry({
                schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(60)]),
              }),
            );
          }),
          { timeout: 600_000 },
        );
        afterAll(
          Effect.gen(function* () {
            if (!RUN_LIVE) return;
            yield* sharedStack.destroy();
          }),
          { timeout: 600_000 },
        );

        test.provider.skipIf(!RUN_LIVE)("all 13 capabilities initialize in the runtime", () =>
          Effect.gen(function* () {
            const response = (yield* get("/bindings")) as any;
            expect(response.bound).toHaveLength(13);
          }),
        );

        test.provider.skipIf(!RUN_LIVE)(
          "GetVehicleStatus reads the bound vehicle's campaign deployments",
          () =>
            Effect.gen(function* () {
              const response = (yield* get("/vehicle-status")) as any;
              expect(typeof response.campaigns).toBe("number");
            }),
        );

        test.provider.skipIf(!RUN_LIVE)(
          "Associate/Disassociate + ListVehiclesInFleet + ListFleetsForVehicle round-trip",
          () =>
            Effect.gen(function* () {
              const associated = (yield* post("/fleet/associate")) as any;
              expect(associated.count).toBeGreaterThanOrEqual(1);
              const fleets = (yield* get("/vehicle-fleets")) as any;
              expect(fleets.count).toBeGreaterThanOrEqual(1);
              const disassociated = (yield* post("/fleet/disassociate")) as any;
              expect(disassociated.ok).toBe(true);
            }),
        );

        test.provider.skipIf(!RUN_LIVE)(
          "signal-definition reads cover catalog, model, and decoder",
          () =>
            Effect.gen(function* () {
              const catalogNodes = (yield* get("/catalog-nodes")) as any;
              expect(catalogNodes.count).toBe(3);
              const modelNodes = (yield* get("/model-nodes")) as any;
              expect(modelNodes.count).toBeGreaterThanOrEqual(2);
              const interfaces = (yield* get("/decoder-interfaces")) as any;
              expect(interfaces.count).toBe(1);
              const signals = (yield* get("/decoder-signals")) as any;
              expect(signals.count).toBe(1);
            }),
        );

        test.provider.skipIf(!RUN_LIVE)("ListVehicles filters by the bound model manifest", () =>
          Effect.gen(function* () {
            const response = (yield* get("/vehicles")) as any;
            expect(response.count).toBeGreaterThanOrEqual(1);
          }),
        );

        test.provider.skipIf(!RUN_LIVE)(
          "UpdateCampaign suspends and resumes the running campaign",
          () =>
            Effect.gen(function* () {
              const response = (yield* post("/campaign/suspend-resume")) as any;
              expect(response.ok).toBe(true);
            }),
        );

        test.provider.skipIf(!RUN_LIVE)(
          "BatchUpdateVehicle succeeds and BatchCreateVehicle surfaces per-item errors",
          () =>
            Effect.gen(function* () {
              const response = (yield* post("/vehicles/batch")) as any;
              expect(response.updated).toBe(1);
              expect(response.updateErrors).toBe(0);
              expect(response.createErrors).toBe(1);
            }),
        );
      },
    );
  },
);
