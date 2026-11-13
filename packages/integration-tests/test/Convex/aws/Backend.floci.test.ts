import * as Convex from "@alchemy.run/convex/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { BACKEND_IMAGE } from "./support.ts";

// In process, so interrupting a deploy that cannot finish also stops its reconcile.
const { test } = Test.make({ providers: Convex.providers(), dev: true, sidecar: false });

// `pnpm test:aws:floci` sets this and points every AWS client at the emulator.
const provider = test.provider.skipIf(process.env.ALCHEMY_TEST_DEV !== "1");

const domain = "convex-floci.test";

const app = (hostedZoneId: string, db: Convex.BackendDb, instanceName?: string) =>
  Convex.Backend("Backend", {
    image: BACKEND_IMAGE,
    domain: { cloud: `cloud.${domain}`, site: `site.${domain}`, hostedZoneId },
    db,
    instanceName,
    deletionProtection: false,
  });

const createZone = Effect.sync(() => crypto.randomUUID()).pipe(
  Effect.flatMap((reference) =>
    route53.createHostedZone({ Name: domain, CallerReference: reference }),
  ),
);

const targetGroupArns = elbv2
  .describeTargetGroups({})
  .pipe(Effect.map(({ TargetGroups }) => (TargetGroups ?? []).map((g) => g.TargetGroupArn!)));

/**
 * Polls until a real container answers health checks on both of this deploy's
 * target groups. The emulator outlives a test run, so older groups are skipped.
 */
const healthyTargets = (older: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const groups = (yield* targetGroupArns).filter((arn) => !older.includes(arn));
    const targets = yield* Effect.forEach(groups, (arn) =>
      elbv2
        .describeTargetHealth({ TargetGroupArn: arn })
        .pipe(Effect.map((health) => health.TargetHealthDescriptions ?? [])),
    );
    const healthy = targets.flat().filter((target) => target.TargetHealth?.State === "healthy");
    return { groups, healthy: healthy.length };
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: ({ healthy }) => healthy === 2,
      times: 90,
    }),
    Effect.map(({ groups, healthy }) => {
      expect(healthy).toBe(2);
      return groups;
    }),
  );

// Floci never marks a rollout COMPLETED, so a deploy can't finish here. Everything
// before that is real, so this asserts on the running deploy. Rollout, TLS and
// DNS are covered on AWS by Backend.sqlite.test.ts.
provider(
  "a real backend container passes both health checks behind the listener rules",
  (stack) =>
    Effect.gen(function* () {
      const zone = yield* createZone;
      const olderGroups = yield* targetGroupArns;
      const olderClusters = (yield* ecs.listClusters({})).clusterArns ?? [];
      const deploy = yield* Effect.forkChild(
        stack.deploy(app(zone.HostedZone.Id, { engine: "sqlite" })),
      );
      const checks = Effect.gen(function* () {
        const groups = yield* healthyTargets(olderGroups);

        const { TargetGroups } = yield* elbv2.describeTargetGroups({ TargetGroupArns: groups });
        const { Listeners } = yield* elbv2.describeListeners({
          LoadBalancerArn: TargetGroups![0]!.LoadBalancerArns![0]!,
        });
        const pages = yield* Effect.forEach(Listeners ?? [], (listener) =>
          elbv2.describeRules({ ListenerArn: listener.ListenerArn! }),
        );
        const rules = pages.flatMap((page) => page.Rules ?? []);
        const hosts = rules
          .flatMap((rule) => rule.Conditions ?? [])
          .flatMap((condition) => condition.HostHeaderConfig?.Values ?? []);
        expect(hosts).toContain(`cloud.${domain}`);
        expect(hosts).toContain(`site.${domain}`);

        const { clusterArns } = yield* ecs.listClusters({});
        const cluster = clusterArns!.find((arn) => !olderClusters.includes(arn))!;
        const { serviceArns } = yield* ecs.listServices({ cluster });
        const { services } = yield* ecs.describeServices({
          cluster,
          services: [serviceArns!.at(-1)!],
        });
        const service = services![0]!;
        expect(service.desiredCount).toBe(1);
        expect(service.deploymentConfiguration?.minimumHealthyPercent).toBe(0);
        expect(service.deploymentConfiguration?.maximumPercent).toBe(100);

        const { taskDefinition } = yield* ecs.describeTaskDefinition({
          taskDefinition: service.taskDefinition!,
        });
        const container = taskDefinition!.containerDefinitions![0]!;
        expect(container.environment?.some((env) => env.name === "INSTANCE_SECRET")).toBe(false);
        expect(container.secrets?.find((s) => s.name === "INSTANCE_SECRET")?.valueFrom).toContain(
          ":ssm:",
        );
        expect(container.portMappings?.map((port) => port.containerPort).sort()).toEqual([
          3210, 3211,
        ]);
      });
      const outcome = yield* Effect.exit(checks);
      yield* Fiber.interrupt(deploy);
      yield* outcome;
    }),
  { tags: ["provider:convex", "provider:convex:backend", "local"], timeout: 420_000 },
);

const POSTGRES = "alchemy-convex-test-postgres";
const POSTGRES_PORT = 15432;

const docker = (...args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make("docker", args, { stdin: "ignore", stderr: "ignore" }),
    );
  });

const removePostgres = docker("rm", "-f", POSTGRES).pipe(Effect.ignore);

const postgresReady = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner;
  return yield* spawner.exitCode(
    ChildProcess.make(
      "docker",
      ["exec", POSTGRES, "pg_isready", "-U", "postgres", "-d", "url_mode"],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ),
  );
});

// Stands in for a server someone already runs: only the URL crosses over, and
// the backend has to connect to the database that was created ahead of time.
provider(
  "url mode connects to an existing database",
  (stack) =>
    Effect.gen(function* () {
      yield* removePostgres;
      yield* docker(
        "run",
        "-d",
        "--name",
        POSTGRES,
        "-p",
        `${POSTGRES_PORT}:5432`,
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-e",
        "POSTGRES_DB=url_mode",
        "postgres:17-alpine",
      );
      const ready = yield* postgresReady.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (code) => code === 0,
          times: 60,
        }),
      );
      expect(ready).toBe(0);

      const zone = yield* createZone;
      const olderGroups = yield* targetGroupArns;
      const olderClusters = (yield* ecs.listClusters({})).clusterArns ?? [];
      const url = Redacted.make(
        `postgres://postgres:postgres@host.docker.internal:${POSTGRES_PORT}/ignored?sslmode=disable`,
      );
      const deploy = yield* Effect.forkChild(
        stack.deploy(
          app(zone.HostedZone.Id, { engine: "postgres", url, requireSsl: false }, "url-mode"),
        ),
      );
      const checks = Effect.gen(function* () {
        yield* healthyTargets(olderGroups);
        const { clusterArns } = yield* ecs.listClusters({});
        const cluster = clusterArns!.find((arn) => !olderClusters.includes(arn))!;
        const { serviceArns } = yield* ecs.listServices({ cluster });
        const { services } = yield* ecs.describeServices({ cluster, services: [serviceArns![0]!] });
        const { taskDefinition } = yield* ecs.describeTaskDefinition({
          taskDefinition: services![0]!.taskDefinition!,
        });
        const container = taskDefinition!.containerDefinitions![0]!;
        expect(JSON.stringify(container)).not.toContain("postgres:postgres");
        expect(container.secrets?.map((secret) => secret.name)).toContain("POSTGRES_URL");

        // The backend wrote its tables into the database named after the instance.
        const tables = yield* docker(
          "exec",
          POSTGRES,
          "psql",
          "-U",
          "postgres",
          "-d",
          "url_mode",
          "-Atc",
          "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')",
        );
        expect(Number(tables.trim())).toBeGreaterThan(0);
      });
      const outcome = yield* Effect.exit(checks);
      yield* Fiber.interrupt(deploy);
      yield* removePostgres;
      yield* outcome;
    }),
  { tags: ["provider:convex", "provider:convex:backend", "local"], timeout: 420_000 },
);
