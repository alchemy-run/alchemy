import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as iam from "@distilled.cloud/aws/iam";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Bundler, type BundleOptions } from "../../Bundle/Bundler.ts";
import {
  cleanupBundleTempDir,
  createTempBundleDir,
} from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { DotAlchemy } from "../../Config.ts";
import { Host, type ServerExecutionContext } from "../../Host.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { ProcessRuntime } from "../../Process/Runtime.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import type { AccountID } from "../Account.ts";
import { Account } from "../Account.ts";
import { Assets } from "../Assets.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { RegionID } from "../Region.ts";
import type { SecurityGroupId } from "./SecurityGroup.ts";
import type { SubnetId } from "./Subnet.ts";
import type { VpcId } from "./Vpc.ts";

export type InstanceId<ID extends string = string> = `i-${ID}`;
export const InstanceId = <ID extends string>(id: ID): ID & InstanceId<ID> =>
  `i-${id}` as ID & InstanceId<ID>;

export type InstanceArn<ID extends InstanceId = InstanceId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:instance/${ID}`;

export const isInstance = (value: any): value is Instance => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.EC2.Instance"
  );
};

export interface InstanceProps {
  /**
   * AMI ID to launch.
   */
  imageId: string;
  /**
   * EC2 instance type, such as `t3.micro`.
   */
  instanceType: string;
  /**
   * Optional subnet to launch into.
   */
  subnetId?: Input<SubnetId>;
  /**
   * Security groups to attach to the primary network interface.
   */
  securityGroupIds?: Input<SecurityGroupId>[];
  /**
   * Optional EC2 key pair name for SSH access.
   */
  keyName?: string;
  /**
   * Optional IAM instance profile name to attach at launch.
   */
  instanceProfileName?: string;
  /**
   * User data script to provide at launch time.
   */
  userData?: string;
  /**
   * Whether to associate a public IPv4 address on launch.
   */
  associatePublicIpAddress?: boolean;
  /**
   * Optional private IPv4 address for the primary interface.
   */
  privateIpAddress?: string;
  /**
   * Optional availability zone override.
   */
  availabilityZone?: string;
  /**
   * Whether source/destination checking is enabled.
   * @default true
   */
  sourceDestCheck?: boolean;
  /**
   * User-defined tags to apply to the instance.
   */
  tags?: Record<string, string>;
  /**
   * Module entrypoint for the bundled instance program.
   * When omitted, the instance behaves as a low-level EC2 resource.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Port exposed by the process, if any.
   * @default 3000
   */
  port?: number;
  /**
   * Additional environment variables for the hosted process.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for the hosted process entrypoint.
   */
  build?: Partial<BundleOptions>;
  /**
   * Additional managed policy ARNs for the managed instance role.
   * This can only be used when Alchemy manages the instance profile.
   */
  roleManagedPolicyArns?: string[];
}

export interface Instance extends Resource<
  "AWS.EC2.Instance",
  InstanceProps,
  {
    /**
     * The ID of the instance.
     */
    instanceId: InstanceId;
    /**
     * The Amazon Resource Name (ARN) of the instance.
     */
    instanceArn: InstanceArn;
    /**
     * The AMI ID the instance launched from.
     */
    imageId: string;
    /**
     * The instance type.
     */
    instanceType: string;
    /**
     * The current instance state.
     */
    state: string;
    /**
     * The VPC the instance belongs to, if any.
     */
    vpcId?: VpcId;
    /**
     * The subnet the instance belongs to, if any.
     */
    subnetId?: SubnetId;
    /**
     * The availability zone of the instance.
     */
    availabilityZone?: string;
    /**
     * The attached security group IDs.
     */
    securityGroupIds: string[];
    /**
     * The primary private IPv4 address.
     */
    privateIpAddress?: string;
    /**
     * The public IPv4 address, if assigned.
     */
    publicIpAddress?: string;
    /**
     * The private DNS name.
     */
    privateDnsName?: string;
    /**
     * The public DNS name, if assigned.
     */
    publicDnsName?: string;
    /**
     * The key pair name used for SSH access.
     */
    keyName?: string;
    /**
     * The IAM instance profile ARN attached to the instance, if any.
     */
    instanceProfileArn?: string;
    /**
     * The IAM instance profile ID attached to the instance, if any.
     */
    instanceProfileId?: string;
    /**
     * The IAM instance profile name attached to the instance, if known.
     */
    instanceProfileName?: string;
    /**
     * Whether source/destination checking is enabled.
     */
    sourceDestCheck?: boolean;
    /**
     * When the instance was launched.
     */
    launchTime?: string;
    /**
     * Current tags on the instance.
     */
    tags: Record<string, string>;
    /**
     * Role attached by the hosted runtime, if any.
     */
    roleArn?: string;
    /**
     * Role name attached by the hosted runtime, if any.
     */
    roleName?: string;
    /**
     * Inline policy name used for bindings/runtime sync, if any.
     */
    policyName?: string;
    /**
     * Whether the role/profile were created and owned by Alchemy.
     */
    managedIam?: boolean;
    /**
     * Deterministic runtime unit name for hosted instances.
     */
    runtimeUnitName?: string;
    /**
     * Asset prefix for hosted bundles and env files.
     */
    assetPrefix?: string;
    /**
     * Bundle hash for hosted instances.
     */
    code?: {
      hash: string;
    };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  }
> {}

/**
 * An EC2 instance that can either act as a low-level compute primitive or run
 * a bundled long-lived Effect program directly on the machine.
 *
 * @section Launching Instances
 * @example Basic Instance
 * ```typescript
 * const instance = yield* AWS.EC2.Instance("AppInstance", {
 *   imageId,
 *   instanceType: "t3.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * @section Hosting Processes
 * @example HTTP Server on an Instance
 * ```typescript
 * const api = yield* Effect.gen(function* () {
 *   yield* Http.serve(
 *     HttpServerResponse.json({ ok: true }),
 *   );
 *
 *   return {
 *     main: import.meta.path,
 *     imageId,
 *     instanceType: "t3.small",
 *     subnetId: subnet.subnetId,
 *     securityGroupIds: [securityGroup.groupId],
 *     associatePublicIpAddress: true,
 *     port: 3000,
 *   };
 * }).pipe(
 *   Effect.provide(AWS.EC2.HttpServer),
 *   AWS.EC2.Instance("ApiInstance"),
 * );
 * ```
 */
export const Instance = Host<
  Instance,
  ServerExecutionContext,
  Credentials | Region | ProcessRuntime
>("AWS.EC2.Instance", (id) => {
  const runners: Effect.Effect<void, never, any>[] = [];
  const env: Record<string, any> = {};

  return {
    type: "AWS.EC2.Instance",
    id,
    env,
    set: (bindingId: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
        env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
        return key;
      }),
    get: <T>(key: string) =>
      Config.string(key)
        .asEffect()
        .pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => JSON.parse(value) as T,
              catch: (error) => error as Error,
            }),
          ),
          Effect.catch((cause) =>
            Effect.die(
              new Error(`Failed to get environment variable: ${key}`, {
                cause,
              }),
            ),
          ),
        ),
    run: ((effect: Effect.Effect<void, never, any>) =>
      Effect.sync(() => {
        runners.push(effect);
      })) as unknown as ServerExecutionContext["run"],
    exports: {
      program: Effect.all(runners, { concurrency: "unbounded" }).pipe(
        Effect.asVoid,
      ),
    },
  } satisfies ServerExecutionContext;
});

export const InstanceProvider = () =>
  Instance.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;
      const stack = yield* Stack;
      const stage = yield* Stage;
      const dotAlchemy = yield* DotAlchemy;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bundler = yield* Bundler;
      const assets = (yield* Effect.serviceOption(Assets)).pipe(
        Option.getOrUndefined,
      );

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const toInstanceArn = (instanceId: InstanceId) =>
        `arn:aws:ec2:${region}:${accountId}:instance/${instanceId}` as InstanceArn;

      const createRoleName = (id: string) =>
        createPhysicalName({
          id: `${id}-role`,
          maxLength: 64,
        });

      const createPolicyName = (id: string) =>
        createPhysicalName({
          id: `${id}-policy`,
          maxLength: 128,
        });

      const createManagedProfileName = (id: string) =>
        createPhysicalName({
          id: `${id}-profile`,
          maxLength: 128,
        });

      const createRuntimeUnitName = (id: string) =>
        createPhysicalName({
          id: `${id}-instance`,
          maxLength: 64,
          lowercase: true,
        }).pipe(Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")));

      const toTagRecord = (tags?: Array<{ Key?: string; Value?: string }>) =>
        Object.fromEntries(
          (tags ?? [])
            .filter((tag): tag is { Key: string; Value: string } =>
              Boolean(tag.Key && tag.Value !== undefined),
            )
            .map((tag) => [tag.Key, tag.Value]),
        );

      const toAttributes = (
        instance: ec2.Instance,
      ): Instance["Attributes"] => ({
        instanceId: instance.InstanceId as InstanceId,
        instanceArn: toInstanceArn(instance.InstanceId as InstanceId),
        imageId: instance.ImageId!,
        instanceType: String(instance.InstanceType ?? ""),
        state: instance.State?.Name ?? "unknown",
        vpcId: instance.VpcId as VpcId | undefined,
        subnetId: instance.SubnetId as SubnetId | undefined,
        availabilityZone: instance.Placement?.AvailabilityZone,
        securityGroupIds: (instance.SecurityGroups ?? [])
          .map((group) => group.GroupId)
          .filter((value): value is string => Boolean(value)),
        privateIpAddress: instance.PrivateIpAddress,
        publicIpAddress: instance.PublicIpAddress,
        privateDnsName: instance.PrivateDnsName,
        publicDnsName: instance.PublicDnsName,
        keyName: instance.KeyName,
        instanceProfileArn: instance.IamInstanceProfile?.Arn,
        instanceProfileId: instance.IamInstanceProfile?.Id,
        instanceProfileName: undefined,
        sourceDestCheck: instance.SourceDestCheck,
        launchTime:
          instance.LaunchTime instanceof Date
            ? instance.LaunchTime.toISOString()
            : (instance.LaunchTime as string | undefined),
        tags: toTagRecord(instance.Tags),
      });

      const describeInstance = (instanceId: string) =>
        ec2
          .describeInstances({
            InstanceIds: [instanceId],
          })
          .pipe(
            Effect.map(
              (result) =>
                (result.Reservations ?? []).flatMap(
                  (reservation) => reservation.Instances ?? [],
                )[0],
            ),
            Effect.flatMap((instance) =>
              instance
                ? Effect.succeed(instance)
                : Effect.fail(new InstanceNotFound({ instanceId })),
            ),
          );

      const findInstanceByTags = Effect.fn(function* (id: string) {
        const filters = yield* createAlchemyTagFilters(id);
        return yield* ec2.describeInstances
          .items({
            Filters: filters,
          })
          .pipe(
            Stream.flatMap((reservation) =>
              Stream.fromArray(reservation.Instances ?? []),
            ),
            Stream.filter((instance) => {
              const state = instance.State?.Name;
              return (
                state === "pending" ||
                state === "running" ||
                state === "stopping" ||
                state === "stopped"
              );
            }),
            Stream.runCollect,
            Effect.map(
              (instances) =>
                [...instances].sort((a, b) => {
                  const aTime =
                    a.LaunchTime instanceof Date
                      ? a.LaunchTime.getTime()
                      : Date.parse(String(a.LaunchTime ?? 0));
                  const bTime =
                    b.LaunchTime instanceof Date
                      ? b.LaunchTime.getTime()
                      : Date.parse(String(b.LaunchTime ?? 0));
                  return bTime - aTime;
                })[0],
            ),
          );
      });

      const waitForState = Effect.fn(function* ({
        instanceId,
        states,
        session,
      }: {
        instanceId: string;
        states: string[];
        session: Pick<ScopedPlanStatusSession, "note">;
      }) {
        return yield* describeInstance(instanceId).pipe(
          Effect.tap((instance) =>
            session.note(
              `Waiting for instance ${instanceId}: ${instance.State?.Name ?? "unknown"}`,
            ),
          ),
          Effect.filterOrFail(
            (instance) => states.includes(instance.State?.Name ?? ""),
            (instance) =>
              new InstanceStateMismatch({
                instanceId,
                actual: instance.State?.Name ?? "unknown",
                expected: states,
              }),
          ),
          Effect.retry({
            while: (error) => error instanceof InstanceStateMismatch,
            schedule: Schedule.exponential("250 millis").pipe(
              Schedule.compose(Schedule.recurs(8)),
            ),
          }),
        );
      });

      const waitForDeleted = Effect.fn(function* ({
        instanceId,
        session,
      }: {
        instanceId: string;
        session: Pick<ScopedPlanStatusSession, "note">;
      }) {
        yield* describeInstance(instanceId).pipe(
          Effect.tap((instance) =>
            session.note(
              `Waiting for instance deletion ${instanceId}: ${instance.State?.Name ?? "unknown"}`,
            ),
          ),
          Effect.flatMap((instance) =>
            instance.State?.Name === "terminated"
              ? Effect.succeed(undefined)
              : Effect.fail(new InstanceStillExists({ instanceId })),
          ),
          Effect.retry({
            while: (error) => error instanceof InstanceStillExists,
            schedule: Schedule.exponential("250 millis").pipe(
              Schedule.compose(Schedule.recurs(8)),
            ),
          }),
          Effect.catchTag("InvalidInstanceID.NotFound", () => Effect.void),
          Effect.catchTag("InstanceNotFound", () => Effect.void),
        );
      });

      const normalizeSecurityGroups = (groups?: readonly string[]) =>
        [...(groups ?? [])].sort((a, b) => a.localeCompare(b));
      const resolvedSubnetId = (subnetId?: InstanceProps["subnetId"]) =>
        subnetId as SubnetId | undefined;
      const resolvedSecurityGroups = (
        groups?: InstanceProps["securityGroupIds"],
      ) => normalizeSecurityGroups(groups as string[] | undefined);

      const bundleProgram = Effect.fn(function* (
        id: string,
        props: InstanceProps,
      ) {
        if (!props.main) {
          return yield* Effect.fail(
            new Error(
              `EC2.Instance '${id}' requires 'main' when bundling a hosted process`,
            ),
          );
        }

        const handler = props.handler ?? "default";
        const outfile = path.join(
          dotAlchemy,
          "out",
          `${stack.name}-${stage}-${id}.mjs`,
        );
        const realMain = yield* fs.realPath(props.main);
        const tempDir = yield* createTempBundleDir(realMain, dotAlchemy, id);
        const realTempDir = yield* fs.realPath(tempDir);
        const tempEntry = path.join(realTempDir, "__index.ts");
        let file = path.relative(realTempDir, realMain);
        if (!file.startsWith(".")) {
          file = `./${file}`;
        }
        file = file.replaceAll("\\", "/");

        yield* fs.writeFileString(
          tempEntry,
          `
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as handler } from "${file}";

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const program = handler.pipe(
  Effect.flatMap((instance) => instance.ExecutionContext.exports.program),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME").asEffect(),
        Config.string("ALCHEMY_STAGE").asEffect()
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
    )
  ),
  Effect.scoped
);

await Effect.runPromise(program);
`,
        );

        return yield* Effect.gen(function* () {
          yield* bundler.build({
            ...props.build,
            entry: tempEntry,
            outfile,
            format: "esm",
            platform: "node",
            target: "node22",
            sourcemap: props.build?.sourcemap ?? false,
            treeshake: props.build?.treeshake ?? true,
            minify: props.build?.minify ?? true,
            external: props.build?.external ?? [],
          });
          const code = yield* fs.readFile(outfile).pipe(Effect.orDie);
          const archive = yield* zipCode(code);
          const hash = yield* sha256(archive);
          return { archive, hash };
        }).pipe(Effect.ensuring(cleanupBundleTempDir(tempDir)));
      });

      const quoteEnvValue = (value: any) => {
        const text =
          typeof value === "string" ? value : JSON.stringify(value ?? null);
        return `'${text.replaceAll(/'/g, `'""'`).replaceAll(/\n/g, "\\n")}'`;
      };

      const renderEnvFile = (env: Record<string, any>) =>
        Object.entries(env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
          .join("\n");

      const renderHostedUserData = ({
        unitName,
        bundleKey,
        envKey,
      }: {
        unitName: string;
        bundleKey: string;
        envKey: string;
      }) => {
        const appDir = `/opt/${unitName}`;
        return `#!/bin/bash
set -euo pipefail

PKG_INSTALL=""
if command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL="dnf install -y"
elif command -v yum >/dev/null 2>&1; then
  PKG_INSTALL="yum install -y"
fi

if [ -n "$PKG_INSTALL" ]; then
  $PKG_INSTALL unzip curl awscli
fi

mkdir -p "${appDir}"

export HOME=/root
if [ ! -x /root/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | bash
fi

cat >/usr/local/bin/${unitName}-sync.sh <<'EOF'
#!/bin/bash
set -euo pipefail
mkdir -p "${appDir}"
aws s3 cp "s3://${assets?.bucketName}/${bundleKey}" "${appDir}/bundle.zip" --region "${region}"
aws s3 cp "s3://${assets?.bucketName}/${envKey}" "${appDir}/env" --region "${region}"
rm -f "${appDir}/index.mjs"
unzip -o "${appDir}/bundle.zip" -d "${appDir}"
EOF
chmod +x /usr/local/bin/${unitName}-sync.sh

cat >/etc/systemd/system/${unitName}.service <<'EOF'
[Unit]
Description=Alchemy EC2 instance runtime ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appDir}
ExecStartPre=/usr/local/bin/${unitName}-sync.sh
EnvironmentFile=${appDir}/env
ExecStart=/root/.bun/bin/bun ${appDir}/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

/usr/local/bin/${unitName}-sync.sh
systemctl daemon-reload
systemctl enable --now ${unitName}.service
`;
      };

      const mergeUserData = (hosted: string, userData?: string) => {
        if (!userData) {
          return hosted;
        }
        return `${hosted}\n\n# User supplied bootstrap\n${userData.replace(
          /^#!\/bin\/bash\s*/,
          "",
        )}`;
      };

      const listAttachedPolicyArns = (roleName: string) =>
        iam
          .listAttachedRolePolicies({
            RoleName: roleName,
          })
          .pipe(
            Effect.map((result) =>
              (result.AttachedPolicies ?? [])
                .map((policy) => policy.PolicyArn)
                .filter((policyArn): policyArn is string => Boolean(policyArn)),
            ),
          );

      const attachManagedPolicies = Effect.fn(function* ({
        roleName,
        managedPolicyArns,
      }: {
        roleName: string;
        managedPolicyArns: string[];
      }) {
        const attached = new Set(yield* listAttachedPolicyArns(roleName));
        for (const policyArn of managedPolicyArns) {
          if (!attached.has(policyArn)) {
            yield* iam.attachRolePolicy({
              RoleName: roleName,
              PolicyArn: policyArn,
            });
          }
        }
      });

      const ensureManagedRole = Effect.fn(function* ({
        id,
        roleName,
        managedPolicyArns,
      }: {
        id: string;
        roleName: string;
        managedPolicyArns: string[];
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "ec2.amazonaws.com",
                  },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }).pipe(
                Effect.filterOrFail(
                  (existing) => hasTags(tags, existing.Role?.Tags),
                  () =>
                    new Error(
                      `Role '${roleName}' already exists and is not managed by alchemy`,
                    ),
                ),
              ),
            ),
          );

        yield* attachManagedPolicies({
          roleName,
          managedPolicyArns,
        });

        return role.Role?.Arn ?? `arn:aws:iam::${accountId}:role/${roleName}`;
      });

      const ensureManagedInstanceProfile = Effect.fn(function* ({
        id,
        profileName,
        roleName,
      }: {
        id: string;
        profileName: string;
        roleName: string;
      }) {
        const tags = yield* createInternalTags(id);
        yield* iam
          .createInstanceProfile({
            InstanceProfileName: profileName,
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () => Effect.void),
          );

        const profile = yield* iam.getInstanceProfile({
          InstanceProfileName: profileName,
        });
        const currentRoleName = profile.InstanceProfile.Roles?.[0]?.RoleName;

        if (currentRoleName && currentRoleName !== roleName) {
          yield* iam.removeRoleFromInstanceProfile({
            InstanceProfileName: profileName,
            RoleName: currentRoleName,
          });
        }

        if (currentRoleName !== roleName) {
          yield* iam.addRoleToInstanceProfile({
            InstanceProfileName: profileName,
            RoleName: roleName,
          });
        }

        const refreshed = yield* iam.getInstanceProfile({
          InstanceProfileName: profileName,
        });
        return {
          instanceProfileName: refreshed.InstanceProfile.InstanceProfileName,
          instanceProfileArn: refreshed.InstanceProfile.Arn,
        };
      });

      const attachHostedBindings = Effect.fn(function* ({
        roleName,
        policyName,
        assetPrefix,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        assetPrefix: string;
        bindings: ResourceBinding<Instance["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<Instance["Binding"]> & { action?: string },
          ) => binding.action !== "delete",
        );

        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, value) => ({ ...acc, ...value }), {});

        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((statement) => ({
              ...statement,
              Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
        );

        policyStatements.push({
          Sid: undefined,
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${assets?.bucketName}/${assetPrefix}/*`],
        });

        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: policyName,
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: policyStatements,
          }),
        });

        return env;
      });

      const uploadHostedArtifacts = Effect.fn(function* ({
        bundleKey,
        envKey,
        archive,
        env,
      }: {
        bundleKey: string;
        envKey: string;
        archive: Uint8Array<ArrayBufferLike>;
        env: Record<string, any>;
      }) {
        if (!assets) {
          return yield* Effect.fail(
            new Error(
              "EC2.Instance host mode requires the AWS assets bucket. Run bootstrap first.",
            ),
          );
        }

        const contentHash = yield* sha256(archive);
        const uploadedAssetKey = yield* assets.uploadAsset(
          contentHash,
          archive,
        );
        yield* s3.copyObject({
          Bucket: assets.bucketName,
          Key: bundleKey,
          CopySource: `${assets.bucketName}/${uploadedAssetKey}`,
        });
        yield* s3.putObject({
          Bucket: assets.bucketName,
          Key: envKey,
          Body: renderEnvFile(env),
          ContentType: "text/plain; charset=utf-8",
        });
      });

      const resolveHostedRuntime = Effect.fn(function* ({
        id,
        news,
        bindings,
        output,
      }: {
        id: string;
        news: InstanceProps;
        bindings: ResourceBinding<Instance["Binding"]>[];
        output?: Instance["Attributes"];
      }) {
        if (!news.main) {
          return {
            userData: news.userData,
            roleName: output?.roleName,
            roleArn: output?.roleArn,
            policyName: output?.policyName,
            instanceProfileName:
              news.instanceProfileName ?? output?.instanceProfileName,
            instanceProfileArn: output?.instanceProfileArn,
            managedIam: output?.managedIam ?? false,
            runtimeUnitName: output?.runtimeUnitName,
            assetPrefix: output?.assetPrefix,
            code: output?.code,
          };
        }

        if (
          news.instanceProfileName &&
          (news.roleManagedPolicyArns?.length ?? 0) > 0
        ) {
          return yield* Effect.fail(
            new Error(
              "EC2.Instance does not support roleManagedPolicyArns with a custom instanceProfileName in host mode",
            ),
          );
        }
        if (!assets) {
          return yield* Effect.fail(
            new Error(
              "EC2.Instance host mode requires the AWS assets bucket. Run bootstrap first.",
            ),
          );
        }

        const runtimeUnitName =
          output?.runtimeUnitName ?? (yield* createRuntimeUnitName(id));
        const assetPrefix = output?.assetPrefix ?? `ec2/${runtimeUnitName}`;
        const bundleKey = `${assetPrefix}/bundle.zip`;
        const envKey = `${assetPrefix}/env`;
        const policyName = output?.policyName ?? (yield* createPolicyName(id));

        const managedIam = !news.instanceProfileName;
        let roleName: string;
        let roleArn: string | undefined;
        let instanceProfileName: string | undefined;
        let instanceProfileArn: string | undefined;

        if (managedIam) {
          roleName = output?.roleName ?? (yield* createRoleName(id));
          roleArn =
            output?.roleArn ??
            (yield* ensureManagedRole({
              id,
              roleName,
              managedPolicyArns: news.roleManagedPolicyArns ?? [],
            }));
          const profileName =
            output?.instanceProfileName ??
            (yield* createManagedProfileName(id));
          const profile = yield* ensureManagedInstanceProfile({
            id,
            profileName,
            roleName,
          });
          instanceProfileName = profile.instanceProfileName;
          instanceProfileArn = profile.instanceProfileArn;
        } else {
          const profile = yield* iam.getInstanceProfile({
            InstanceProfileName: news.instanceProfileName!,
          });
          const role = profile.InstanceProfile.Roles?.[0];
          if (!role?.RoleName) {
            return yield* Effect.fail(
              new Error(
                `Instance profile '${news.instanceProfileName}' must have a role attached for host mode`,
              ),
            );
          }
          roleName = role.RoleName;
          roleArn = role.Arn;
          instanceProfileName = profile.InstanceProfile.InstanceProfileName;
          instanceProfileArn = profile.InstanceProfile.Arn;
        }

        const bindingEnv = yield* attachHostedBindings({
          roleName,
          policyName,
          assetPrefix,
          bindings,
        });
        const env = {
          ...bindingEnv,
          ...alchemyEnv,
          ...(news.port !== undefined ? { PORT: news.port } : {}),
          ...news.env,
        };

        const { archive, hash } = yield* bundleProgram(id, news);
        yield* uploadHostedArtifacts({
          bundleKey,
          envKey,
          archive,
          env,
        });

        const hostedUserData = renderHostedUserData({
          unitName: runtimeUnitName,
          bundleKey,
          envKey,
        });

        return {
          userData: mergeUserData(hostedUserData, news.userData),
          roleName,
          roleArn,
          policyName,
          instanceProfileName,
          instanceProfileArn,
          managedIam,
          runtimeUnitName,
          assetPrefix,
          code: {
            hash,
          },
        };
      });

      const buildRunInstancesRequest = (
        news: InstanceProps,
        runtime: {
          userData?: string;
          instanceProfileName?: string;
        },
        tags: Record<string, string>,
      ): ec2.RunInstancesRequest => {
        const encodedUserData = runtime.userData
          ? Buffer.from(runtime.userData).toString("base64")
          : undefined;
        const usePrimaryNetworkInterface =
          news.subnetId !== undefined ||
          news.associatePublicIpAddress !== undefined ||
          news.privateIpAddress !== undefined;

        return {
          ImageId: news.imageId,
          InstanceType: news.instanceType as ec2.InstanceType,
          MinCount: 1,
          MaxCount: 1,
          KeyName: news.keyName,
          IamInstanceProfile: runtime.instanceProfileName
            ? {
                Name: runtime.instanceProfileName,
              }
            : undefined,
          UserData: encodedUserData,
          Placement: news.availabilityZone
            ? {
                AvailabilityZone: news.availabilityZone,
              }
            : undefined,
          NetworkInterfaces: usePrimaryNetworkInterface
            ? [
                {
                  DeviceIndex: 0,
                  SubnetId: resolvedSubnetId(news.subnetId),
                  Groups: resolvedSecurityGroups(news.securityGroupIds),
                  AssociatePublicIpAddress: news.associatePublicIpAddress,
                  PrivateIpAddress: news.privateIpAddress,
                  DeleteOnTermination: true,
                },
              ]
            : undefined,
          SubnetId: usePrimaryNetworkInterface
            ? undefined
            : resolvedSubnetId(news.subnetId),
          SecurityGroupIds: usePrimaryNetworkInterface
            ? undefined
            : resolvedSecurityGroups(news.securityGroupIds),
          PrivateIpAddress: usePrimaryNetworkInterface
            ? undefined
            : news.privateIpAddress,
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: createTagsList(tags),
            },
          ],
        };
      };

      return {
        stables: ["instanceId", "instanceArn", "vpcId", "subnetId"],
        diff: Effect.fn(function* ({ news, olds }) {
          const hostModeChanged = Boolean(olds.main) !== Boolean(news.main);
          if (
            hostModeChanged ||
            olds.imageId !== news.imageId ||
            olds.subnetId !== news.subnetId ||
            olds.keyName !== news.keyName ||
            olds.instanceProfileName !== news.instanceProfileName ||
            olds.userData !== news.userData ||
            olds.associatePublicIpAddress !== news.associatePublicIpAddress ||
            olds.privateIpAddress !== news.privateIpAddress ||
            olds.availabilityZone !== news.availabilityZone
          ) {
            return { action: "replace" } as const;
          }

          if (
            olds.instanceType !== news.instanceType ||
            olds.sourceDestCheck !== news.sourceDestCheck ||
            olds.main !== news.main ||
            olds.handler !== news.handler ||
            olds.port !== news.port ||
            JSON.stringify(olds.env ?? {}) !== JSON.stringify(news.env ?? {}) ||
            JSON.stringify(olds.build ?? {}) !==
              JSON.stringify(news.build ?? {}) ||
            JSON.stringify(olds.roleManagedPolicyArns ?? []) !==
              JSON.stringify(news.roleManagedPolicyArns ?? []) ||
            JSON.stringify(resolvedSecurityGroups(olds.securityGroupIds)) !==
              JSON.stringify(resolvedSecurityGroups(news.securityGroupIds)) ||
            JSON.stringify(olds.tags ?? {}) !== JSON.stringify(news.tags ?? {})
          ) {
            return {
              action: "update",
              stables: ["instanceId", "instanceArn", "vpcId", "subnetId"],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, output }) {
          const instance = output?.instanceId
            ? yield* describeInstance(output.instanceId).pipe(
                Effect.catchTag("InvalidInstanceID.NotFound", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("InstanceNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : yield* findInstanceByTags(id);
          return instance
            ? {
                ...toAttributes(instance),
                instanceProfileName: output?.instanceProfileName,
                roleArn: output?.roleArn,
                roleName: output?.roleName,
                policyName: output?.policyName,
                managedIam: output?.managedIam,
                runtimeUnitName: output?.runtimeUnitName,
                assetPrefix: output?.assetPrefix,
                code: output?.code,
              }
            : undefined;
        }),
        create: Effect.fn(function* ({ id, news, output, bindings, session }) {
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const runtime = yield* resolveHostedRuntime({
            id,
            news,
            bindings,
            output,
          });

          const existing = output?.instanceId
            ? yield* describeInstance(output.instanceId).pipe(
                Effect.catchTag("InvalidInstanceID.NotFound", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("InstanceNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : yield* findInstanceByTags(id);

          if (existing) {
            return {
              ...toAttributes(existing),
              instanceProfileName:
                runtime.instanceProfileName ?? output?.instanceProfileName,
              roleArn: runtime.roleArn,
              roleName: runtime.roleName,
              policyName: runtime.policyName,
              managedIam: runtime.managedIam,
              runtimeUnitName: runtime.runtimeUnitName,
              assetPrefix: runtime.assetPrefix,
              code: runtime.code,
            };
          }

          const created = yield* ec2
            .runInstances(buildRunInstancesRequest(news, runtime, tags))
            .pipe(
              Effect.retry({
                while: (error) => {
                  const tag = (error as { _tag?: string })._tag;
                  return (
                    tag === "InvalidIAMInstanceProfile.NotFound" ||
                    tag === "InvalidParameterValue"
                  );
                },
                schedule: Schedule.exponential("500 millis").pipe(
                  Schedule.compose(Schedule.recurs(8)),
                ),
              }),
            );

          const instanceId = created.Instances?.[0]?.InstanceId as
            | InstanceId
            | undefined;
          if (!instanceId) {
            return yield* Effect.fail(
              new Error(`RunInstances returned no instance ID for '${id}'`),
            );
          }

          yield* session.note(instanceId);
          const instance = yield* waitForState({
            instanceId,
            states: ["running"],
            session,
          });

          if (news.sourceDestCheck !== undefined) {
            yield* ec2.modifyInstanceAttribute({
              InstanceId: instanceId,
              SourceDestCheck: {
                Value: news.sourceDestCheck,
              },
            });
          }

          const refreshed = yield* describeInstance(instanceId);
          return {
            ...toAttributes(refreshed ?? instance),
            instanceProfileName: runtime.instanceProfileName,
            roleArn: runtime.roleArn,
            roleName: runtime.roleName,
            policyName: runtime.policyName,
            managedIam: runtime.managedIam,
            runtimeUnitName: runtime.runtimeUnitName,
            assetPrefix: runtime.assetPrefix,
            code: runtime.code,
          };
        }),
        update: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          bindings,
          session,
        }) {
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const runtime = yield* resolveHostedRuntime({
            id,
            news,
            bindings,
            output,
          });
          let restarted = false;

          if (
            JSON.stringify(resolvedSecurityGroups(olds.securityGroupIds)) !==
            JSON.stringify(resolvedSecurityGroups(news.securityGroupIds))
          ) {
            yield* ec2.modifyInstanceAttribute({
              InstanceId: output.instanceId,
              Groups: resolvedSecurityGroups(news.securityGroupIds),
            });
          }

          if (olds.sourceDestCheck !== news.sourceDestCheck) {
            yield* ec2.modifyInstanceAttribute({
              InstanceId: output.instanceId,
              SourceDestCheck: {
                Value: news.sourceDestCheck ?? true,
              },
            });
          }

          if (olds.instanceType !== news.instanceType) {
            const before = yield* describeInstance(output.instanceId);
            const wasRunning = before.State?.Name === "running";
            if (wasRunning) {
              yield* ec2.stopInstances({
                InstanceIds: [output.instanceId],
              });
              yield* waitForState({
                instanceId: output.instanceId,
                states: ["stopped"],
                session,
              });
            }

            yield* ec2.modifyInstanceAttribute({
              InstanceId: output.instanceId,
              InstanceType: {
                Value: news.instanceType as ec2.InstanceType,
              },
            });

            if (wasRunning) {
              yield* ec2.startInstances({
                InstanceIds: [output.instanceId],
              });
              yield* waitForState({
                instanceId: output.instanceId,
                states: ["running"],
                session,
              });
              restarted = true;
            }
          }

          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...olds.tags,
          };
          const { removed, upsert } = diffTags(oldTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [output.instanceId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [output.instanceId],
              Tags: upsert,
            });
          }

          if (news.main && !restarted) {
            yield* ec2.rebootInstances({
              InstanceIds: [output.instanceId],
            });
            yield* waitForState({
              instanceId: output.instanceId,
              states: ["running"],
              session,
            });
          }

          return {
            ...toAttributes(yield* describeInstance(output.instanceId)),
            instanceProfileName:
              runtime.instanceProfileName ?? output.instanceProfileName,
            roleArn: runtime.roleArn ?? output.roleArn,
            roleName: runtime.roleName ?? output.roleName,
            policyName: runtime.policyName ?? output.policyName,
            managedIam: runtime.managedIam ?? output.managedIam,
            runtimeUnitName: runtime.runtimeUnitName ?? output.runtimeUnitName,
            assetPrefix: runtime.assetPrefix ?? output.assetPrefix,
            code: runtime.code ?? output.code,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ec2
            .terminateInstances({
              InstanceIds: [output.instanceId],
            })
            .pipe(
              Effect.catchTag("InvalidInstanceID.NotFound", () => Effect.void),
            );
          yield* waitForDeleted({
            instanceId: output.instanceId,
            session,
          });

          if (output.roleName && output.policyName) {
            yield* iam
              .deleteRolePolicy({
                RoleName: output.roleName,
                PolicyName: output.policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }

          if (
            output.managedIam &&
            output.instanceProfileName &&
            output.roleName
          ) {
            const attachedPolicyArns = yield* listAttachedPolicyArns(
              output.roleName,
            ).pipe(Effect.catch(() => Effect.succeed([])));
            yield* iam
              .removeRoleFromInstanceProfile({
                InstanceProfileName: output.instanceProfileName,
                RoleName: output.roleName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            yield* iam
              .deleteInstanceProfile({
                InstanceProfileName: output.instanceProfileName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            for (const policyArn of attachedPolicyArns) {
              yield* iam
                .detachRolePolicy({
                  RoleName: output.roleName,
                  PolicyArn: policyArn,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
            yield* iam
              .deleteRole({
                RoleName: output.roleName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }

          if (assets && output.assetPrefix) {
            for (const key of [
              `${output.assetPrefix}/bundle.zip`,
              `${output.assetPrefix}/env`,
            ]) {
              yield* s3
                .deleteObject({
                  Bucket: assets.bucketName,
                  Key: key,
                })
                .pipe(Effect.catchTag("NotFound", () => Effect.void));
            }
          }
        }),
      };
    }),
  );

class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
  instanceId: string;
}> {}

class InstanceStillExists extends Data.TaggedError("InstanceStillExists")<{
  instanceId: string;
}> {}

class InstanceStateMismatch extends Data.TaggedError("InstanceStateMismatch")<{
  instanceId: string;
  actual: string;
  expected: string[];
}> {}
