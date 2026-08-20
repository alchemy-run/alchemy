import * as Alchemy from "alchemy";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ResourceClass } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const isStackProcess = process.env.MULTI_CLOUD_FIXTURE_MODE === "stack";

// -----------------------------------------------------------------------------
// Lifecycle test
// -----------------------------------------------------------------------------

async function registerLifecycleTest(): Promise<void> {
  const [{ exec }, NodeServices, { describe, expect, test }, { ChildProcess }] =
    await Promise.all([
      import("@/Util/exec.ts"),
      import("@effect/platform-node/NodeServices"),
      import("alchemy-test"),
      import("effect/unstable/process"),
    ]);

  describe("alchemy plan property details", () => {
    test.effect(
      "runs the local deploy → plan → cleanup user flow",
      () =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* exec(
            ChildProcess.make(process.execPath, [currentFile], {
              shell: false,
            }),
          ).pipe(Effect.scoped);

          expect(stderr).toBe("");
          expect(stdout).toContain("Step 1/3: deploy baseline stack");
          expect(stdout).toContain("Step 2/3: plan updated stack");
          expect(stdout).toContain(
            "✔ compact and detailed plans verified for 20 resources",
          );
          expect(stdout).toContain("Step 3/3: remove disposable local state");
          expect(stdout).toContain("✔ temporary runtime and state removed");
          expect(exitCode).toBe(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      { timeout: 30_000 },
    );
  });
}

// -----------------------------------------------------------------------------
// Directly runnable local user flow
// -----------------------------------------------------------------------------

function runLifecycle(verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageRoot = path.resolve(path.dirname(currentFile), "../..");
    const cli = path.join(packageRoot, "bin/alchemy.ts");

    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "alchemy-plan-diff-flow-" }),
      (runtime) =>
        Effect.gen(function* () {
          const dotAlchemy = path.join(runtime, ".alchemy");
          yield* fs.makeDirectory(dotAlchemy, { recursive: true });
          // Suppress the CLI's periodic npm lookup so this local lifecycle stays hermetic.
          yield* fs.writeFileString(
            path.join(dotAlchemy, "version-check.json"),
            JSON.stringify({ checkedAt: 9_999_999_999_999 }),
          );

          yield* Effect.sync(() =>
            console.log("Step 1/3: deploy baseline stack"),
          );
          const created = yield* Effect.tryPromise(() =>
            runCli(
              cli,
              runtime,
              ["deploy", "--yes", "--detailed"],
              "baseline",
              verbose,
            ),
          );
          if (!verbose) {
            yield* Effect.sync(() => verifyDetailedCreate(created));
          }
          yield* verifyPersistedState(runtime);
          yield* Effect.sync(() =>
            console.log("✔ created and persisted 20 local resources"),
          );
          yield* pauseForReview(
            verbose,
            "Press Enter to show the compact update plan...",
          );

          yield* Effect.sync(() =>
            console.log("\nStep 2/3: plan updated stack"),
          );
          const compact = yield* Effect.tryPromise(() =>
            runCli(cli, runtime, ["plan"], "updated", verbose),
          );
          if (!verbose) {
            yield* Effect.sync(() => verifyCompactPlan(compact));
          }
          yield* pauseForReview(
            verbose,
            "Press Enter to show the detailed update plan...",
          );

          const detailed = yield* Effect.tryPromise(() =>
            runCli(cli, runtime, ["plan", "--detailed"], "updated", verbose),
          );
          if (!verbose) {
            yield* Effect.sync(() => verifyDetailedPlan(detailed));
          }
          yield* Effect.sync(() =>
            console.log(
              "✔ compact and detailed plans verified for 20 resources",
            ),
          );
          yield* pauseForReview(
            verbose,
            "Press Enter to remove the temporary state and exit...",
          );
        }),
      (runtime) =>
        Effect.gen(function* () {
          yield* Effect.sync(() =>
            console.log("\nStep 3/3: remove disposable local state"),
          );
          yield* fs.remove(runtime, { recursive: true, force: true });
          yield* Effect.sync(() =>
            console.log("✔ temporary runtime and state removed"),
          );
        }),
    );
  });
}

const pauseForReview = (enabled: boolean, message: string) =>
  enabled
    ? Effect.promise(async () => {
        const readline = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          await readline.question(`\n${message}`);
        } finally {
          readline.close();
        }
      })
    : Effect.void;

async function runCli(
  cli: string,
  runtime: string,
  command:
    | ["plan"]
    | ["plan", "--detailed"]
    | ["deploy", "--yes", "--detailed"],
  revision: "baseline" | "updated",
  interactive: boolean,
): Promise<string> {
  const arguments_ = [
    process.execPath,
    cli,
    command[0],
    currentFile,
    "--stage",
    "acceptance",
    ...command.slice(1),
  ];
  const environment: Record<string, string | undefined> = {
    ...process.env,
    MULTI_CLOUD_FIXTURE_MODE: "stack",
    MULTI_CLOUD_REVISION: revision,
  };

  if (interactive) {
    delete environment.ALCHEMY_PLAIN;
    delete environment.ALCHEMY_NO_TUI;
    delete environment.CI;
    console.log(`\n$ ${displayCommand(command)}\n`);

    const child = Bun.spawn(arguments_, {
      cwd: runtime,
      env: environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`${command.join(" ")} exited with ${exitCode}`);
    }
    return "";
  }

  const child = Bun.spawn(arguments_, {
    cwd: runtime,
    env: {
      ...environment,
      ALCHEMY_PLAIN: "1",
      CI: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  }
  if (stderr !== "") {
    throw new Error(`${command.join(" ")} wrote to stderr:\n${stderr}`);
  }
  return stdout;
}

function displayCommand(
  command:
    | ["plan"]
    | ["plan", "--detailed"]
    | ["deploy", "--yes", "--detailed"],
): string {
  return command[0] === "deploy"
    ? "alchemy deploy --detailed --yes"
    : `alchemy ${command.join(" ")}`;
}

function verifyDetailedCreate(output: string): void {
  const expected = [
    "Plan: 20 to create",
    "[ApiFunction] create",
    "environment.API_TOKEN  (redacted)",
    'handler  "src/api.handler"',
    "[EdgeWorker] create",
    'compatibilityDate  "2026-01-01"',
    "[Network] create",
    'tags.Environment  "staging"',
  ];
  const missing = expected.filter((value) => !output.includes(value));
  if (missing.length > 0 || output.includes("(not set)")) {
    throw new Error(
      `Detailed create rendered the wrong properties:\n${missing.join("\n")}`,
    );
  }
  verifyNoLeaks(output);
}

function verifyPersistedState(runtime: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDirectory = path.join(
      runtime,
      ".alchemy",
      "state",
      "MultiCloudPlanPropertyDiff",
      "acceptance",
    );
    const resourceStates = (yield* fs.readDirectory(stateDirectory)).filter(
      (file) => file.endsWith(".json") && file !== "__stack_output__.json",
    );
    if (resourceStates.length !== 20) {
      return yield* Effect.fail(
        new Error(
          `Expected 20 persisted resource states, got ${resourceStates.length}`,
        ),
      );
    }
  });
}

function verifyCompactPlan(output: string): void {
  const resourceRows = changedResourceRows(output);
  if (resourceRows.length !== 20) {
    throw new Error(
      `Expected 20 compact resource rows, got ${resourceRows.length}`,
    );
  }
  if (
    !output.includes("Plan: 16 to update, 4 to replace") ||
    output.includes("compatibilityDate") ||
    output.includes("known after apply")
  ) {
    throw new Error("Compact lifecycle plan rendered the wrong detail level");
  }
  verifyNoLeaks(output);
}

function verifyDetailedPlan(output: string): void {
  const resourceRows = changedResourceRows(output);
  if (resourceRows.length !== 20) {
    throw new Error(
      `Expected 20 detailed resource rows, got ${resourceRows.length}`,
    );
  }

  const expected = [
    "[EdgeWorker] update",
    'compatibilityDate  "2026-01-01" → "2026-08-19"',
    "vars.SESSION_KEY  (redacted) → (redacted)",
    "[NatGateway] replace",
    'allocationId  "eipalloc-staging" → "eipalloc-production"',
    "[PrivateRoutes] update",
    "routes[0].natGatewayId",
    "(known after apply)",
    "[RdsPrimary] replace",
    "monitoringRoleArn  null → (not set)",
    "[SessionDurableObject] replace",
    "[AssetsBucket] replace",
    "[ApiDnsRecord] update",
    "ttl  (not set) → 60",
  ];
  const missing = expected.filter((value) => !output.includes(value));
  if (missing.length > 0) {
    throw new Error(
      `Missing expected multi-cloud output:\n${missing.join("\n")}`,
    );
  }
  verifyNoLeaks(output);
}

function changedResourceRows(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /^\[[^\]]+\] (update|replace)$/.test(line));
}

function verifyNoLeaks(output: string): void {
  const forbidden = [
    "staging-api-token",
    "production-api-token",
    "staging-session-key",
    "production-session-key",
    "simulated Lambda handler must not execute during plan",
  ].filter((value) => output.includes(value));
  if (forbidden.length > 0) {
    throw new Error(
      `Sensitive or computed values leaked: ${forbidden.join(", ")}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Local multi-cloud stack fixture
// -----------------------------------------------------------------------------

type Props = Record<string, unknown>;
type Attributes = { id: string; arn: string };
type SimulatedResource<Type extends string> = Alchemy.Resource<
  Type,
  Props,
  Attributes
>;

const simulated = <const Type extends string>(type: Type) =>
  Alchemy.Resource<SimulatedResource<Type>>(type);

const Vpc = simulated("AWS.EC2.VPC");
const InternetGateway = simulated("AWS.EC2.InternetGateway");
const PublicSubnet = simulated("AWS.EC2.Subnet.Public");
const PrivateSubnet = simulated("AWS.EC2.Subnet.Private");
const NatGateway = simulated("AWS.EC2.NatGateway");
const RouteTable = simulated("AWS.EC2.RouteTable");
const SecurityGroup = simulated("AWS.EC2.SecurityGroup");
const Ec2Instance = simulated("AWS.EC2.Instance");
const EcsCluster = simulated("AWS.ECS.Cluster");
const EcsService = simulated("AWS.ECS.Service");
const EksCluster = simulated("AWS.EKS.Cluster");
const RdsInstance = simulated("AWS.RDS.DBInstance");
const AuroraCluster = simulated("AWS.RDS.DBCluster");
const LambdaFunction = simulated("AWS.Lambda.Function");
const IamRole = simulated("AWS.IAM.Role");
const Worker = simulated("Cloudflare.Worker");
const DurableObject = simulated("Cloudflare.DurableObject");
const KvNamespace = simulated("Cloudflare.KV.Namespace");
const R2Bucket = simulated("Cloudflare.R2.Bucket");
const DnsRecord = simulated("Cloudflare.DNS.Record");

const replacements = new Set([
  "NatGateway",
  "RdsPrimary",
  "SessionDurableObject",
  "AssetsBucket",
]);

// Resource names are representative only; providers and state stay local and
// never contact AWS or Cloudflare.
const providerFor = <const Type extends string>(
  resource: ResourceClass<SimulatedResource<Type>>,
) =>
  Provider.succeed(resource, {
    list: () => Effect.succeed([]),
    diff: ({ id, olds, news }) =>
      Effect.succeed(
        isResolved(news) && !havePropsChanged(olds, news)
          ? ({ action: "noop" } as const)
          : replacements.has(id)
            ? ({ action: "replace" } as const)
            : ({ action: "update", stables: ["id", "arn"] } as const),
      ),
    reconcile: ({ id }) =>
      Effect.succeed({ id: `${id}-id`, arn: `arn:simulated:${id}` }),
    delete: () => Effect.void,
  });

const providers = Layer.mergeAll(
  providerFor(Vpc),
  providerFor(InternetGateway),
  providerFor(PublicSubnet),
  providerFor(PrivateSubnet),
  providerFor(NatGateway),
  providerFor(RouteTable),
  providerFor(SecurityGroup),
  providerFor(Ec2Instance),
  providerFor(EcsCluster),
  providerFor(EcsService),
  providerFor(EksCluster),
  providerFor(RdsInstance),
  providerFor(AuroraCluster),
  providerFor(LambdaFunction),
  providerFor(IamRole),
  providerFor(Worker),
  providerFor(DurableObject),
  providerFor(KvNamespace),
  providerFor(R2Bucket),
  providerFor(DnsRecord),
);

const revision = process.env.MULTI_CLOUD_REVISION ?? "updated";
if (revision !== "baseline" && revision !== "updated") {
  throw new Error(`Unknown MULTI_CLOUD_REVISION '${revision}'`);
}
const updated = revision === "updated";
const choose = <T>(baseline: T, next: T): T => (updated ? next : baseline);

export default Alchemy.Stack(
  "MultiCloudPlanPropertyDiff",
  {
    providers,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const vpc = yield* Vpc("Network", {
      cidrBlock: "10.0.0.0/16",
      enableDnsHostnames: true,
      tags: {
        Environment: choose("staging", "production"),
        Owner: "platform",
        ...(updated ? { CostCenter: "core" } : {}),
      },
    });
    yield* InternetGateway("InternetGateway", {
      vpcId: vpc.id,
      tags: { Environment: choose("staging", "production") },
    });
    const publicSubnet = yield* PublicSubnet("PublicSubnet", {
      vpcId: vpc.id,
      cidrBlock: "10.0.1.0/24",
      mapPublicIpOnLaunch: !updated,
      tags: { Tier: "public", Environment: choose("staging", "production") },
    });
    const privateSubnet = yield* PrivateSubnet("PrivateSubnet", {
      vpcId: vpc.id,
      cidrBlock: "10.0.10.0/24",
      mapPublicIpOnLaunch: false,
      tags: {
        Tier: "private",
        Environment: choose("staging", "production"),
        ...(updated ? { DataClassification: "confidential" } : {}),
      },
    });
    const nat = yield* NatGateway("NatGateway", {
      subnetId: publicSubnet.id,
      allocationId: choose("eipalloc-staging", "eipalloc-production"),
      connectivityType: "public",
    });
    yield* RouteTable("PrivateRoutes", {
      vpcId: vpc.id,
      routes: [
        { destinationCidrBlock: "0.0.0.0/0", natGatewayId: nat.id },
        ...(updated
          ? [
              {
                destinationCidrBlock: "10.20.0.0/16",
                transitGatewayId: "tgw-production",
              },
            ]
          : []),
      ],
    });
    const securityGroup = yield* SecurityGroup("ApplicationSecurityGroup", {
      vpcId: vpc.id,
      ingress: [
        {
          protocol: "tcp",
          fromPort: choose(80, 443),
          toPort: choose(80, 443),
          cidrBlocks: ["10.0.0.0/16"],
        },
        ...(updated
          ? [
              {
                protocol: "tcp",
                fromPort: 22,
                toPort: 22,
                cidrBlocks: ["10.99.0.0/16"],
              },
            ]
          : []),
      ],
      egress: [{ protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    });
    yield* Ec2Instance("Bastion", {
      subnetId: publicSubnet.id,
      securityGroupIds: [securityGroup.id],
      instanceType: choose("t3.small", "t3.medium"),
      detailedMonitoring: updated,
    });
    const ecsCluster = yield* EcsCluster("ApplicationCluster", {
      name: choose("application-staging", "application-production"),
      containerInsights: choose("disabled", "enabled"),
    });
    yield* EcsService("ApiService", {
      clusterArn: ecsCluster.arn,
      desiredCount: choose(2, 4),
      deployment: {
        minimumHealthyPercent: choose(50, 100),
        maximumPercent: 200,
      },
    });
    yield* EksCluster("KubernetesCluster", {
      version: choose("1.31", "1.32"),
      subnetIds: [publicSubnet.id, privateSubnet.id],
      endpointPrivateAccess: updated,
    });
    yield* RdsInstance("RdsPrimary", {
      engine: "postgres",
      engineVersion: choose("15.7", "16.3"),
      instanceClass: choose("db.t4g.medium", "db.r7g.large"),
      multiAz: updated,
      ...(updated ? {} : { monitoringRoleArn: null }),
    });
    yield* AuroraCluster("AuroraCluster", {
      engine: "aurora-postgresql",
      engineMode: "provisioned",
      backupRetentionPeriod: choose(7, 14),
      serverlessV2Scaling: {
        minCapacity: choose(0.5, 1),
        maxCapacity: choose(4, 16),
      },
    });
    yield* LambdaFunction("ApiFunction", {
      memorySize: choose(512, 1024),
      timeout: choose(15, 30),
      handler: updated
        ? Effect.die(
            new Error("simulated Lambda handler must not execute during plan"),
          )
        : "src/api.handler",
      environment: {
        LOG_LEVEL: choose("info", "warn"),
        API_TOKEN: Redacted.make(
          choose("staging-api-token", "production-api-token"),
        ),
      },
    });
    yield* IamRole("ApplicationRole", {
      path: "/application/",
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
        ...(updated
          ? ["arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"]
          : []),
      ],
      inlinePolicy: {
        Statement: [
          {
            Effect: "Allow",
            Action: updated
              ? ["s3:GetObject", "s3:PutObject"]
              : ["s3:GetObject"],
            Resource: "arn:aws:s3:::assets/*",
          },
          ...(updated
            ? [
                {
                  Effect: "Allow",
                  Action: ["sqs:SendMessage"],
                  Resource: "arn:aws:sqs:eu-central-1:123456789012:jobs",
                },
              ]
            : []),
        ],
      },
    });
    yield* Worker("EdgeWorker", {
      compatibilityDate: choose("2026-01-01", "2026-08-19"),
      compatibilityFlags: [
        "nodejs_compat",
        ...(updated ? ["streams_enable_constructors"] : []),
      ],
      vars: {
        ORIGIN: choose(
          "https://staging.example.com",
          "https://api.example.com",
        ),
        SESSION_KEY: Redacted.make(
          choose("staging-session-key", "production-session-key"),
        ),
      },
    });
    yield* DurableObject("SessionDurableObject", {
      className: choose("SessionV1", "SessionV2"),
      sqlite: updated,
      migrationTag: choose("v1", "v2"),
    });
    yield* KvNamespace("EdgeConfig", {
      title: choose("edge-config-staging", "edge-config-production"),
    });
    yield* R2Bucket("AssetsBucket", {
      name: choose("assets-staging", "assets-production"),
      jurisdiction: choose("default", "eu"),
      storageClass: choose("Standard", "InfrequentAccess"),
    });
    yield* DnsRecord("ApiDnsRecord", {
      zoneId: "zone-example",
      name: "api.example.com",
      type: "CNAME",
      content: choose(
        "staging.example.workers.dev",
        "production.example.workers.dev",
      ),
      proxied: true,
      ...(updated ? { ttl: 60 } : {}),
    });
  }),
);

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--verbose")) {
    console.error(`Usage: bun ${currentFile} [--verbose]`);
    process.exit(1);
  }
  const verbose = arguments_.includes("--verbose");
  if (verbose && !process.stdout.isTTY) {
    console.error("--verbose requires an interactive terminal (TTY)");
    process.exit(1);
  }
  const NodeServices = await import("@effect/platform-node/NodeServices");
  await Effect.runPromise(
    runLifecycle(verbose).pipe(Effect.provide(NodeServices.layer)),
  );
} else if (!isStackProcess) {
  await registerLifecycleTest();
}
