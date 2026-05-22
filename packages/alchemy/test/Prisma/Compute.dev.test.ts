import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Prisma.providers(), dev: true });

test.provider("dev mode returns a local Compute without a token", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const app = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Prisma.Compute("App", {
          project: "project-dev",
          serviceName: "api",
          port: 8787,
          dev: {
            url: "http://localhost:8787",
          },
        });
      }),
    );

    expect(app.local).toBe(true);
    expect(app.url).toBe("http://localhost:8787");
    expect(app.computeServiceId).toContain("dev:");

    yield* stack.destroy();
  }),
);

test.provider("dev mode supports the same stack shape with Project", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const output = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          name: "local-project",
          createDatabase: false,
        });
        const app = yield* Prisma.Compute("AppWithProject", {
          project,
          serviceName: "api",
          port: 8787,
          dev: {
            url: "http://localhost:8787",
          },
        });
        return { project, app };
      }),
    );

    expect(output.project.projectId).toBe("dev:project:Project");
    expect(output.app.projectId).toBe(output.project.projectId);
    expect(output.app.local).toBe(true);
    expect(output.app.url).toBe("http://localhost:8787");

    yield* stack.destroy();
  }),
);

test.provider(
  "dev mode resolves all owned Prisma resource shapes without a token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", {
            name: "local-project",
          });
          const database = yield* Prisma.Database("Database", {
            project,
            name: "main",
            isDefault: true,
          });
          const connection = yield* Prisma.Connection("Connection", {
            database,
            name: "api",
          });
          const branch = yield* Prisma.Branch("Branch", {
            project,
            gitName: "main",
            isDefault: true,
          });
          const service = yield* Prisma.ComputeService("ComputeService", {
            project,
            displayName: "api",
            branchId: branch.branchId,
          });
          const version = yield* Prisma.ComputeVersion("ComputeVersion", {
            computeService: service,
            portMapping: { http: 3000 },
          });
          const env = yield* Prisma.EnvironmentVariable("Environment", {
            project,
            class: "production",
            key: "TOKEN",
            value: Redacted.make("secret"),
          });
          const repo = yield* Prisma.SourceRepository("SourceRepository", {
            project,
            providerRepositoryId: 123,
          });

          return {
            project,
            database,
            connection,
            branch,
            service,
            version,
            env,
            repo,
          };
        }),
      );

      expect(output.project.projectId).toBe("dev:project:Project");
      expect(output.database.projectId).toBe(output.project.projectId);
      expect(output.database.databaseId).toBe("dev:database:Database");
      expect(output.connection.databaseId).toBe(output.database.databaseId);
      expect(output.branch.projectId).toBe(output.project.projectId);
      expect(output.branch.isDefault).toBe(true);
      expect(output.service.projectId).toBe(output.project.projectId);
      expect(output.service.branchId).toBe(output.branch.branchId);
      expect(output.version.computeServiceId).toBe(
        output.service.computeServiceId,
      );
      expect(output.env.projectId).toBe(output.project.projectId);
      expect(output.env.key).toBe("TOKEN");
      expect(Redacted.value(output.env.value)).toBe("secret");
      expect(output.repo.projectId).toBe(output.project.projectId);
      expect(output.repo.repoId).toBe(123);

      yield* stack.destroy();
    }),
);

test.provider(
  "dev mode starts a local command and passes env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-dev-",
      });
      const scriptPath = path.join(root, "dev-server.sh");
      const outputPath = path.join(root, "dev-output.json");
      const stoppedPath = path.join(root, "dev-stopped.txt");

      yield* fs.writeFileString(
        scriptPath,
        [
          "trap 'printf stopped > dev-stopped.txt; exit 0' TERM INT",
          'printf \'{"port":"%s","greeting":"%s"}\' "$PORT" "$GREETING" > dev-output.json',
          "while true; do sleep 1; done",
          "",
        ].join("\n"),
      );

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Prisma.Compute("AppWithCommand", {
            project: "project-dev",
            serviceName: "api",
            path: root,
            port: 8788,
            env: {
              GREETING: "hello-dev",
            },
            dev: {
              command: "sh dev-server.sh",
              cwd: root,
              port: 8789,
            },
          });
        }),
      );

      expect(app.local).toBe(true);
      expect(app.url).toBe("http://localhost:8789");

      const output = yield* fs.readFileString(outputPath).pipe(
        Effect.retry({
          schedule: Schedule.fixed("50 millis").pipe(
            Schedule.both(Schedule.recurs(40)),
          ),
        }),
      );

      expect(JSON.parse(output)).toEqual({
        port: "8789",
        greeting: "hello-dev",
      });

      yield* stack.destroy();

      const stopped = yield* fs.readFileString(stoppedPath).pipe(
        Effect.retry({
          schedule: Schedule.fixed("50 millis").pipe(
            Schedule.both(Schedule.recurs(40)),
          ),
        }),
      );

      expect(stopped).toBe("stopped");
    }),
  { timeout: 10_000 },
);
