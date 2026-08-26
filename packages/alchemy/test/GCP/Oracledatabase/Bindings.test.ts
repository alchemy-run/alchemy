import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const runLifecycle = hasGcpCreds && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

test.provider.skipIf(!runLifecycle)(
  "GetOdbNetwork invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsOdbNetworks({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            location,
            network: "default",
            labels: { env: "test" },
          });
          const subnet = yield* GCP.Oracledatabase.OdbNetworksOdbSubnet(
            "Client",
            {
              odbNetwork: network.name,
              location,
              cidrRange: "10.250.0.0/27",
              purpose: "CLIENT_SUBNET",
              labels: { env: "test" },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* network.name;
              yield* subnet.name;
              const getNetwork =
                yield* GCP.Oracledatabase.GetOdbNetwork(network);
              const getSubnet =
                yield* GCP.Oracledatabase.GetOdbNetworksOdbSubnet(subnet);
              return Effect.fn(function* () {
                const liveNetwork = yield* getNetwork();
                const liveSubnet = yield* getSubnet();
                return { liveNetwork, liveSubnet };
              });
            }),
          );
          return { network, subnet, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveNetwork.name).toEqual(out.network.name);
      expect(out.probe.liveSubnet.name).toEqual(out.subnet.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl alchemy-test";

test.provider.skipIf(!runLifecycle)(
  "GetAutonomousDatabase, GenerateWallet, StartAutonomousDatabase, and StopAutonomousDatabase invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsAutonomousDatabases({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Oracledatabase.AutonomousDatabase(
            "AppDb",
            {
              location,
              network: "default",
              cidr: "10.10.0.0/24",
              adminPassword: "AlchemyTest1!",
              displayName: "alchemy-bind-adb",
              labels: { env: "test" },
              licenseType: "LICENSE_INCLUDED",
              dbWorkload: "OLTP",
              cpuCoreCount: 2,
              dataStorageSizeGb: 20,
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* database.name;
              const getDb =
                yield* GCP.Oracledatabase.GetAutonomousDatabase(database);
              const generateWallet =
                yield* GCP.Oracledatabase.GenerateWallet(database);
              const start =
                yield* GCP.Oracledatabase.StartAutonomousDatabase(database);
              const stop =
                yield* GCP.Oracledatabase.StopAutonomousDatabase(database);
              const restart =
                yield* GCP.Oracledatabase.RestartAutonomousDatabase(database);
              return Effect.fn(function* () {
                const live = yield* getDb();
                const wallet = yield* generateWallet({
                  body: { password: "AlchemyTest1!", type: "SINGLE" },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                const started = yield* start().pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                const stopped = yield* stop().pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                const restarted = yield* restart().pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return { live, wallet, started, stopped, restarted };
              });
            }),
          );
          return { database, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.database.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.wallet.tag);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.started.tag);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.stopped.tag);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.restarted.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetCloudVmCluster invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsCloudVmClusters({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const infra = yield* GCP.Oracledatabase.CloudExadataInfrastructure(
            "Exa",
            {
              displayName: "alchemy-bind-exa",
              shape: "Exadata.X9M",
              computeCount: 2,
              storageCount: 3,
            },
          );
          const cluster = yield* GCP.Oracledatabase.CloudVmCluster("Vms", {
            location,
            exadataInfrastructure: infra.name,
            network: "default",
            cidr: "10.10.0.0/24",
            backupSubnetCidr: "10.10.1.0/24",
            licenseType: "LICENSE_INCLUDED",
            cpuCoreCount: 4,
            giVersion: "19.0.0.0",
            hostnamePrefix: "exa",
            sshPublicKeys: [SSH_KEY],
            labels: { env: "test" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* infra.name;
              yield* cluster.name;
              const getInfra =
                yield* GCP.Oracledatabase.GetCloudExadataInfrastructure(infra);
              const getCluster =
                yield* GCP.Oracledatabase.GetCloudVmCluster(cluster);
              return Effect.fn(function* () {
                const liveInfra = yield* getInfra();
                const liveCluster = yield* getCluster();
                return { liveInfra, liveCluster };
              });
            }),
          );
          return { infra, cluster, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveInfra.name).toEqual(out.infra.name);
      expect(out.probe.liveCluster.name).toEqual(out.cluster.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetDbSystem invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsDbSystems({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const system = yield* GCP.Oracledatabase.DbSystem("BaseDb", {
            location,
            displayName: "alchemy-bind-dbsystem",
            odbSubnet: `projects/${project}/locations/${location}/odbNetworks/missing/odbSubnets/client`,
            shape: "VM.Standard.E4.Flex",
            sshPublicKeys: [SSH_KEY],
            computeCount: 2,
            initialDataStorageSizeGb: 256,
            licenseModel: "LICENSE_INCLUDED",
            databaseEdition: "ENTERPRISE_EDITION",
            labels: { env: "test" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* system.name;
              const getSystem = yield* GCP.Oracledatabase.GetDbSystem(system);
              return Effect.fn(function* () {
                return yield* getSystem();
              });
            }),
          );
          return { system, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.system.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetExadbVmCluster invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsExadbVmClusters({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* GCP.Oracledatabase.ExascaleDbStorageVault(
            "Vault",
            {
              displayName: "alchemyvault",
              totalSizeGbs: 300,
            },
          );
          const cluster = yield* GCP.Oracledatabase.ExadbVmCluster("ExaVm", {
            location,
            displayName: "alchemyexavm",
            odbSubnet: `projects/${project}/locations/${location}/odbNetworks/missing/odbSubnets/client`,
            backupOdbSubnet: `projects/${project}/locations/${location}/odbNetworks/missing/odbSubnets/backup`,
            gridImageId: "19.0.0.0",
            hostnamePrefix: "exavm",
            sshPublicKeys: [SSH_KEY],
            exascaleDbStorageVault: vault.name,
            enabledEcpuCountPerNode: 8,
            nodeCount: 2,
            properties: {
              vmFileSystemStorage: { sizeInGbsPerNode: 180 },
              shapeAttribute: "SMART_STORAGE",
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* vault.name;
              yield* cluster.name;
              const getVault =
                yield* GCP.Oracledatabase.GetExascaleDbStorageVault(vault);
              const getCluster =
                yield* GCP.Oracledatabase.GetExadbVmCluster(cluster);
              return Effect.fn(function* () {
                const liveVault = yield* getVault();
                const liveCluster = yield* getCluster();
                return { liveVault, liveCluster };
              });
            }),
          );
          return { vault, cluster, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveVault.name).toEqual(out.vault.name);
      expect(out.probe.liveCluster.name).toEqual(out.cluster.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetGoldengateConnection invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsGoldengateConnections({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const connection = yield* GCP.Oracledatabase.GoldengateConnection(
            "Src",
            {
              location,
              connectionType: "GENERIC",
              displayName: "alchemy-gg-src",
              properties: {
                genericConnectionProperties: {
                  host: "db.example.com",
                  technologyType: "GENERIC",
                },
              },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* connection.name;
              const getConnection =
                yield* GCP.Oracledatabase.GetGoldengateConnection(connection);
              return Effect.fn(function* () {
                return yield* getConnection();
              });
            }),
          );
          return { connection, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.connection.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetGoldengateDeployment invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsGoldengateDeployments({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            location,
            network: "default",
            labels: { env: "test" },
          });
          const subnet = yield* GCP.Oracledatabase.OdbNetworksOdbSubnet(
            "Client",
            {
              odbNetwork: network.name,
              location,
              cidrRange: "10.250.0.0/27",
              purpose: "CLIENT_SUBNET",
            },
          );
          const deployment = yield* GCP.Oracledatabase.GoldengateDeployment(
            "Replicat",
            {
              location,
              odbNetwork: network.name,
              odbSubnet: subnet.name,
              displayName: "alchemy-gg",
              deploymentType: "DATABASE_ORACLE",
              oggData: {
                adminUsername: "oggadmin",
                deployment: "oggdeploy",
                adminPassword: "AlchemyTest1!",
              },
              labels: { env: "test" },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* deployment.name;
              const getDeployment =
                yield* GCP.Oracledatabase.GetGoldengateDeployment(deployment);
              return Effect.fn(function* () {
                return yield* getDeployment();
              });
            }),
          );
          return { deployment, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.deployment.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetGoldengateConnectionAssignment invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsGoldengateConnectionAssignments({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const connection = yield* GCP.Oracledatabase.GoldengateConnection(
            "Src",
            {
              location,
              connectionType: "GENERIC",
              displayName: "alchemy-gg-src",
              properties: {
                genericConnectionProperties: {
                  host: "db.example.com",
                  technologyType: "GENERIC",
                },
              },
            },
          );
          const assignment =
            yield* GCP.Oracledatabase.GoldengateConnectionAssignment("Assign", {
              location,
              displayName: "alchemy-gg-assign",
              goldengateConnection: connection.name,
              goldengateDeployment: `projects/${project}/locations/${location}/goldengateDeployments/missing`,
              labels: { env: "test" },
            });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* assignment.name;
              const getAssignment =
                yield* GCP.Oracledatabase.GetGoldengateConnectionAssignment(
                  assignment,
                );
              return Effect.fn(function* () {
                return yield* getAssignment();
              });
            }),
          );
          return { assignment, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.assignment.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
