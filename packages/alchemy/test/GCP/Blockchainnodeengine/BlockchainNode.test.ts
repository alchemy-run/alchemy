import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bne from "@distilled.cloud/gcp/blockchainnodeengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parent = `projects/${project}/locations/us-central1`;

// Blockchain Node Engine is entitlement-gated on the default testing
// project (`Forbidden`: "Blockchain Node Engine API has not been used in
// project alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_BLOCKCHAINNODEENGINE=1 on an entitled project to run the
// lifecycle. Nodes take 15-45 minutes to provision, so FAST also skips.
const entitled = process.env.GCP_TEST_BLOCKCHAINNODEENGINE === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  bne.getProjectsLocationsBlockchainNodes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBlockchainNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bne.getProjectsLocationsBlockchainNodes({
          name: `${parent}/blockchainNodes/alchemy-bne-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "Blockchain Node Engine API has not been used",
        );
      }

      const page = yield* bne
        .listProjectsLocationsBlockchainNodes({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ blockchainNodes: [] as const }),
          ),
        );
      expect(Array.isArray(page.blockchainNodes ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createProjectsLocationsBlockchainNodes is rejected with Forbidden when Blockchain Node Engine is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bne.createProjectsLocationsBlockchainNodes({
          parent,
          blockchainNodeId: "alchemy-bne-probe",
          body: {
            blockchainType: "ETHEREUM",
            ethereumDetails: {
              network: "TESTNET_SEPOLIA",
              nodeType: "FULL",
              executionClient: "GETH",
              consensusClient: "LIGHTHOUSE",
            },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a blockchain node",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Blockchainnodeengine.BlockchainNode("Sepolia", {
            location: "us-central1",
            blockchainType: "ETHEREUM",
            ethereumDetails: {
              network: "TESTNET_SEPOLIA",
              nodeType: "FULL",
              executionClient: "GETH",
              consensusClient: "LIGHTHOUSE",
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/blockchainNodes/");
      expect(created.blockchainNodeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.blockchainType).toEqual("ETHEREUM");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.ethereumDetails?.network).toEqual("TESTNET_SEPOLIA");

      const fetched = yield* bne.getProjectsLocationsBlockchainNodes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.ethereumDetails?.network).toEqual("TESTNET_SEPOLIA");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Blockchainnodeengine.BlockchainNode("Sepolia", {
            blockchainNodeId: created.blockchainNodeId,
            location: "us-central1",
            blockchainType: "ETHEREUM",
            ethereumDetails: {
              network: "TESTNET_SEPOLIA",
              nodeType: "FULL",
              executionClient: "GETH",
              consensusClient: "LIGHTHOUSE",
            },
            labels: { env: "prod", role: "node" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.blockchainNodeId).toEqual(created.blockchainNodeId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "node" });

      const refetched = yield* bne.getProjectsLocationsBlockchainNodes({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("node");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
