import { AlchemyContext } from "@/AlchemyContext";
import * as Provider from "@/Provider";
import * as Prisma from "@/Prisma";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const devAlchemyContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: true,
  adopt: false,
});

const providePrismaDev = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Prisma.providers()),
    Effect.provide(devAlchemyContext),
  );

const reconcileInput = (id: string, news: unknown, output?: unknown) =>
  ({
    id,
    instanceId: "00000000000000000000000000000000",
    news,
    olds: undefined,
    output,
    session: undefined as never,
    bindings: [],
  }) as never;

describe("Prisma providers", () => {
  it.effect("registers every Prisma resource provider", () =>
    Effect.gen(function* () {
      const resourceTypes = [
        Prisma.Project.Type,
        Prisma.Database.Type,
        Prisma.Connection.Type,
        Prisma.Branch.Type,
        Prisma.Compute.Type,
        Prisma.ComputeService.Type,
        Prisma.ComputeVersion.Type,
        Prisma.CustomDomain.Type,
        Prisma.EnvironmentVariable.Type,
        Prisma.SourceRepository.Type,
      ];
      const expectedStables = new Map([
        [Prisma.Project.Type, ["projectId"]],
        [Prisma.Database.Type, ["databaseId"]],
        [Prisma.Connection.Type, ["connectionId"]],
        [Prisma.Branch.Type, ["branchId"]],
        [Prisma.Compute.Type, ["computeServiceId"]],
        [Prisma.ComputeService.Type, ["computeServiceId"]],
        [Prisma.ComputeVersion.Type, ["computeVersionId"]],
        [Prisma.CustomDomain.Type, ["customDomainId"]],
        [Prisma.EnvironmentVariable.Type, ["environmentVariableId"]],
        [Prisma.SourceRepository.Type, ["sourceRepositoryId"]],
      ]);

      const providers = yield* Effect.all(
        resourceTypes.map((type) => Provider.findProviderByType(type as any)),
        { concurrency: "unbounded" },
      );

      expect(providers).toHaveLength(resourceTypes.length);
      for (const provider of providers) {
        expect(typeof provider.reconcile).toBe("function");
        expect(typeof provider.delete).toBe("function");
      }
      for (let i = 0; i < resourceTypes.length; i += 1) {
        expect(providers[i]?.stables).toEqual(
          expectedStables.get(resourceTypes[i]),
        );
      }
    }).pipe(providePrismaDev),
  );

  it.effect("uses tokenless dev providers from Prisma.providers()", () =>
    Effect.gen(function* () {
      const projectProvider = yield* Provider.findProviderByType(
        Prisma.Project.Type as any,
      );
      const serviceProvider = yield* Provider.findProviderByType(
        Prisma.ComputeService.Type as any,
      );
      const envProvider = yield* Provider.findProviderByType(
        Prisma.EnvironmentVariable.Type as any,
      );

      const project = (yield* projectProvider.reconcile(
        reconcileInput("Project", {
          name: "local-project",
          createDatabase: false,
        }),
      )) as Prisma.Project["Attributes"];
      const service = (yield* serviceProvider.reconcile(
        reconcileInput("ComputeService", {
          project,
          displayName: "api",
          regionId: "us-east-1",
        }),
      )) as Prisma.ComputeService["Attributes"];
      const env = (yield* envProvider.reconcile(
        reconcileInput("Environment", {
          project,
          class: "production",
          key: "TOKEN",
          value: Redacted.make("secret"),
        }),
      )) as Prisma.EnvironmentVariable["Attributes"];

      expect(project.projectId).toBe("dev:project:Project");
      expect(service.projectId).toBe(project.projectId);
      expect(service.computeServiceId).toBe(
        "dev:compute-service:ComputeService",
      );
      expect(env.projectId).toBe(project.projectId);
      expect(Redacted.value(env.value)).toBe("secret");
    }).pipe(providePrismaDev),
  );

  it.effect(
    "provides PrismaClient for operation helpers through managementApi()",
    () =>
      Effect.gen(function* () {
        const client = yield* Prisma.PrismaClient;

        expect(typeof client.listProjects).toBe("function");
        expect(typeof client.createProjectComputeService).toBe("function");
        expect(typeof client.getComputeVersionLogsUrl).toBe("function");
      }).pipe(
        Effect.provide(Prisma.managementApi()),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PRISMA_SERVICE_TOKEN: "test-token",
            }),
          ),
        ),
      ),
  );
});
