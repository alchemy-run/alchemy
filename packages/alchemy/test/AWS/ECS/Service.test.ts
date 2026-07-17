import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2/Subnet.ts";
import { Vpc } from "@/AWS/EC2/Vpc.ts";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region collection, fanned out per
// cluster): deploy a real cluster + service, resolve the provider from context
// via the typed `findProvider`, call `list()`, and assert the deployed service
// appears in the exhaustively-paginated result
// (listClusters -> listServices -> describeServices hydration).
//
// To stay inside the speed budget we avoid building/pushing a Docker image
// (the canonical `AWS.ECS.Task` resource) and instead register a minimal task
// definition against a public image and run the service at `desiredCount: 0`,
// so `createService` returns immediately without waiting for Fargate task
// placement. Networking is a throwaway VPC + single subnet (no NAT/IGW needed
// since no task is ever launched).
test.provider("list enumerates the deployed service", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Register a minimal Fargate task definition pointing at a public image.
    const registered = yield* ecs.registerTaskDefinition({
      family: "alchemy-test-ecs-service-list",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      containerDefinitions: [
        {
          name: "app",
          image: "public.ecr.aws/nginx/nginx:stable",
          essential: true,
          portMappings: [{ containerPort: 80, protocol: "tcp" }],
        },
      ],
    });
    const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn;
    if (!taskDefinitionArn) {
      return yield* Effect.die(
        new Error("registerTaskDefinition returned no task definition ARN"),
      );
    }
    // Safety net: deregister the out-of-band task definition on scope close even
    // if the body fails — leaves it INACTIVE rather than orphaned as ACTIVE.
    yield* Effect.addFinalizer(() =>
      ecs
        .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
        .pipe(Effect.ignore),
    );

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListServiceVpc", {
          cidrBlock: "10.71.0.0/16",
        });
        const subnet = yield* Subnet("ListServiceSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.71.1.0/24",
        });
        const cluster = yield* Cluster("ListServiceCluster", {
          clusterName: "alchemy-test-ecs-service-list",
        });
        return yield* Service("ListService", {
          cluster,
          task: {
            taskDefinitionArn,
            containerName: "app",
            port: 80,
          },
          desiredCount: 0,
          vpcId: vpc.vpcId,
          subnets: [subnet.subnetId],
        });
      }),
    );

    const provider = yield* Provider.findProvider(Service);
    const all = yield* provider.list();

    expect(all.some((s) => s.serviceArn === service.serviceArn)).toBe(true);
    const found = all.find((s) => s.serviceArn === service.serviceArn);
    expect(found?.serviceName).toEqual(service.serviceName);
    expect(found?.clusterArn).toEqual(service.clusterArn);

    yield* stack.destroy();

    yield* ecs
      .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
      .pipe(Effect.catchTag("ClientException", () => Effect.void));
  }),
);

// In-place reconcile coverage: create a service at desiredCount 0 (so
// createService returns immediately without waiting on Fargate placement),
// then update the network configuration (assignPublicIp), desiredCount, the
// deployment circuit breaker, and tags — and assert the service was updated in
// place (SAME serviceArn, no replacement). This exercises the per-aspect
// updateService + tag-sync path and the narrowed `diff` (these fields must NOT
// force a replace).
test.provider(
  "service applies network / desiredCount / deployment / tag changes in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const registered = yield* ecs.registerTaskDefinition({
        family: "alchemy-test-ecs-service-inplace",
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "app",
            image: "public.ecr.aws/nginx/nginx:stable",
            essential: true,
            portMappings: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      });
      const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn!;
      // Safety net: deregister the out-of-band task definition on scope close.
      yield* Effect.addFinalizer(() =>
        ecs
          .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
          .pipe(Effect.ignore),
      );

      const deployService = (props: {
        desiredCount: number;
        assignPublicIp: boolean;
        tags: Record<string, string>;
        circuitBreaker: boolean;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("InPlaceVpc", { cidrBlock: "10.72.0.0/16" });
            const subnet = yield* Subnet("InPlaceSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.72.1.0/24",
            });
            const cluster = yield* Cluster("InPlaceCluster", {
              clusterName: "alchemy-test-ecs-service-inplace",
            });
            return yield* Service("InPlaceService", {
              cluster,
              task: { taskDefinitionArn, containerName: "app", port: 80 },
              desiredCount: props.desiredCount,
              vpcId: vpc.vpcId,
              subnets: [subnet.subnetId],
              assignPublicIp: props.assignPublicIp,
              tags: props.tags,
              deploymentConfiguration: {
                minimumHealthyPercent: 100,
                maximumPercent: 200,
                deploymentCircuitBreaker: {
                  enable: props.circuitBreaker,
                  rollback: props.circuitBreaker,
                },
              },
            });
          }),
        );

      const created = yield* deployService({
        desiredCount: 0,
        assignPublicIp: false,
        tags: { env: "test", keep: "v1" },
        circuitBreaker: false,
      });

      const updated = yield* deployService({
        desiredCount: 0,
        assignPublicIp: true,
        tags: { env: "test", added: "new" },
        circuitBreaker: true,
      });

      // No replacement — identity is stable.
      expect(updated.serviceArn).toEqual(created.serviceArn);

      // Verify out-of-band that updateService applied the changes.
      const described = yield* ecs.describeServices({
        cluster: updated.clusterArn,
        services: [updated.serviceName],
        include: ["TAGS"],
      });
      const svc = described.services?.[0];
      expect(svc?.serviceArn).toEqual(created.serviceArn);
      expect(
        svc?.deploymentConfiguration?.deploymentCircuitBreaker?.enable,
      ).toBe(true);
      expect(
        svc?.networkConfiguration?.awsvpcConfiguration?.assignPublicIp,
      ).toBe("ENABLED");

      // Tag reconcile: `keep` removed, `added` present, `env` retained.
      const tagMap = Object.fromEntries(
        (svc?.tags ?? []).map((t) => [t.key, t.value]),
      );
      expect(tagMap.added).toBe("new");
      expect(tagMap.env).toBe("test");
      expect(tagMap.keep).toBeUndefined();

      yield* stack.destroy();
      yield* ecs
        .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
        .pipe(Effect.catchTag("ClientException", () => Effect.void));
    }),
  { timeout: 240_000 },
);

// Manual (user-supplied) load balancer: create an ALB + target group OUT OF
// BAND, pass it explicitly via `loadBalancers` with `public: false`, and assert
// (a) no Alchemy-managed ALB was created (no `url`/`loadBalancerArn` on the
// attributes) and (b) the service is wired to the supplied target group.
//
// ECS `createService` rejects a target group that is not associated with a load
// balancer (`InvalidParameterException`), so we provision a real (but minimal)
// ALB + listener + target group out of band across two AZ subnets, wire the
// service to that target group with `public: false`, and assert no
// Alchemy-managed ALB was created.
test.provider(
  "service wires a user-supplied target group without creating an ALB",
  (stack) =>
    Effect.gen(function* () {
      // Clean up any out-of-band ELBv2 leftovers from a prior interrupted run
      // BEFORE destroying the stack: a stale ALB holds ENIs in the stack's
      // VPC, which deadlocks the VPC deletion inside `stack.destroy()`. It
      // also keeps the fresh ALB, target group, and listener consistently
      // wired (a stale, unassociated target group would make `createService`
      // reject with `InvalidParameterException`).
      const existingLbs = yield* elbv2
        .describeLoadBalancers({ Names: ["alchemy-test-ecs-manuallb"] })
        .pipe(Effect.catch(() => Effect.succeed({ LoadBalancers: [] })));
      for (const lb of existingLbs.LoadBalancers ?? []) {
        const ls = yield* elbv2
          .describeListeners({ LoadBalancerArn: lb.LoadBalancerArn! })
          .pipe(Effect.catch(() => Effect.succeed({ Listeners: [] })));
        for (const l of ls.Listeners ?? []) {
          yield* elbv2
            .deleteListener({ ListenerArn: l.ListenerArn! })
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* elbv2
          .deleteLoadBalancer({ LoadBalancerArn: lb.LoadBalancerArn! })
          .pipe(Effect.catch(() => Effect.void));
      }
      if ((existingLbs.LoadBalancers ?? []).length > 0) {
        yield* Effect.sleep("8 seconds");
      }
      const existingTgs = yield* elbv2
        .describeTargetGroups({ Names: ["alchemy-test-ecs-manuallb"] })
        .pipe(Effect.catch(() => Effect.succeed({ TargetGroups: [] })));
      for (const tg of existingTgs.TargetGroups ?? []) {
        yield* elbv2
          .deleteTargetGroup({ TargetGroupArn: tg.TargetGroupArn! })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "ResourceInUseException",
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(5),
              ]),
            }),
            Effect.catch(() => Effect.void),
          );
      }

      yield* stack.destroy();

      const registered = yield* ecs.registerTaskDefinition({
        family: "alchemy-test-ecs-service-manuallb",
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "app",
            image: "public.ecr.aws/nginx/nginx:stable",
            essential: true,
            portMappings: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      });
      const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn!;
      // Safety net: deregister the out-of-band task definition on scope close.
      yield* Effect.addFinalizer(() =>
        ecs
          .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
          .pipe(Effect.ignore),
      );

      // Resolve two available AZs in the active region — hardcoding zone
      // names breaks as soon as the profile targets a different region.
      const azResult = yield* ec2.describeAvailabilityZones({});
      const availableAzs = (azResult.AvailabilityZones ?? []).filter(
        (az) => az.State === "available",
      );
      const az1 = availableAzs[0]?.ZoneName!;
      const az2 = availableAzs[1]?.ZoneName!;

      // Deploy networking first so we can resolve concrete ids for the
      // out-of-band ELBv2 resources.
      const net = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ManualLbVpc", { cidrBlock: "10.73.0.0/16" });
          const subnetA = yield* Subnet("ManualLbSubnetA", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.73.1.0/24",
            availabilityZone: az1,
          });
          const subnetB = yield* Subnet("ManualLbSubnetB", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.73.2.0/24",
            availabilityZone: az2,
          });
          const cluster = yield* Cluster("ManualLbCluster", {
            clusterName: "alchemy-test-ecs-service-manuallb",
          });
          return {
            vpcId: vpc.vpcId.as<string>(),
            subnetAId: subnetA.subnetId.as<string>(),
            subnetBId: subnetB.subnetId.as<string>(),
            clusterArn: cluster.clusterArn.as<string>(),
          };
        }),
      );

      // Create a real (internal) ALB + target group + listener out of band so
      // the target group is associated with a load balancer.
      const loadBalancer = yield* elbv2.createLoadBalancer({
        Name: "alchemy-test-ecs-manuallb",
        Type: "application",
        Scheme: "internal",
        Subnets: [net.subnetAId, net.subnetBId],
      });
      const loadBalancerArn = loadBalancer.LoadBalancers?.[0]?.LoadBalancerArn!;
      // Safety-net finalizers (run LIFO on scope close): listener -> TG -> ALB,
      // so the out-of-band ELBv2 resources are reclaimed even if the body fails.
      yield* Effect.addFinalizer(() =>
        elbv2
          .deleteLoadBalancer({ LoadBalancerArn: loadBalancerArn })
          .pipe(Effect.ignore),
      );

      const targetGroup = yield* elbv2.createTargetGroup({
        Name: "alchemy-test-ecs-manuallb",
        VpcId: net.vpcId,
        TargetType: "ip",
        Protocol: "HTTP",
        Port: 80,
      });
      const targetGroupArn = targetGroup.TargetGroups?.[0]?.TargetGroupArn!;
      yield* Effect.addFinalizer(() =>
        elbv2
          .deleteTargetGroup({ TargetGroupArn: targetGroupArn })
          .pipe(Effect.ignore),
      );

      const listener = yield* elbv2.createListener({
        LoadBalancerArn: loadBalancerArn,
        Port: 80,
        Protocol: "HTTP",
        DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
      });
      const listenerArn = listener.Listeners?.[0]?.ListenerArn!;
      yield* Effect.addFinalizer(() =>
        elbv2.deleteListener({ ListenerArn: listenerArn }).pipe(Effect.ignore),
      );

      // Re-declare the same networking (idempotent — same logical ids) plus the
      // Service wired to the user-supplied target group.
      const service = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ManualLbVpc", { cidrBlock: "10.73.0.0/16" });
          const subnetA = yield* Subnet("ManualLbSubnetA", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.73.1.0/24",
            availabilityZone: az1,
          });
          const subnetB = yield* Subnet("ManualLbSubnetB", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.73.2.0/24",
            availabilityZone: az2,
          });
          const cluster = yield* Cluster("ManualLbCluster", {
            clusterName: "alchemy-test-ecs-service-manuallb",
          });
          return yield* Service("ManualLbService", {
            cluster,
            task: { taskDefinitionArn, containerName: "app", port: 80 },
            desiredCount: 0,
            public: false,
            vpcId: vpc.vpcId,
            subnets: [subnetA.subnetId, subnetB.subnetId],
            loadBalancers: [
              { targetGroupArn, containerName: "app", containerPort: 80 },
            ],
          });
        }),
      );

      // No Alchemy-managed ALB.
      expect(service.loadBalancerArn).toBeUndefined();
      expect(service.url).toBeUndefined();

      const described = yield* ecs.describeServices({
        cluster: service.clusterArn,
        services: [service.serviceName],
      });
      const lbs = described.services?.[0]?.loadBalancers ?? [];
      expect(lbs.length).toBe(1);
      expect(lbs[0]?.containerName).toBe("app");
      expect(lbs[0]?.targetGroupArn).toBe(targetGroupArn);

      // Delete the service first (it references the target group), then tear
      // down the out-of-band ELBv2 resources, then the rest of the stack.
      yield* ecs
        .deleteService({
          cluster: service.clusterArn,
          service: service.serviceName,
          force: true,
        })
        .pipe(Effect.catch(() => Effect.void));
      yield* elbv2
        .deleteListener({ ListenerArn: listenerArn })
        .pipe(Effect.catch(() => Effect.void));
      yield* elbv2
        .deleteLoadBalancer({ LoadBalancerArn: loadBalancerArn })
        .pipe(Effect.catch(() => Effect.void));
      yield* elbv2
        .deleteTargetGroup({ TargetGroupArn: targetGroupArn })
        .pipe(Effect.catch(() => Effect.void));

      yield* stack.destroy();
      yield* ecs
        .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
        .pipe(Effect.catchTag("ClientException", () => Effect.void));
    }),
  { timeout: 240_000 },
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the service as `status: "creating"`
// with no attributes — and the Output-valued props (`cluster` passed as a
// resource object, `task`, `vpcId`, `subnets`) do not survive the state
// round-trip: they deserialize as `undefined`. Plan's recovery branch then
// calls `provider.read` with those junk props, which crashed in
// `clusterArnOf(undefined)` and wedged the stack (plan/deploy/destroy all
// build a plan, so there was no CLI escape hatch).
//
// Simulate exactly that state row after a real deploy and assert the next
// deploy recovers: `read` reports "not found", the engine re-drives the
// create, and reconcile converges on the half-created service by name —
// SAME serviceArn, no replacement.
test.provider(
  "recovers a half-created service whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const registered = yield* ecs.registerTaskDefinition({
        family: "alchemy-test-ecs-service-wedged",
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "app",
            image: "public.ecr.aws/nginx/nginx:stable",
            essential: true,
            portMappings: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      });
      const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn!;
      // Safety net: deregister the out-of-band task definition on scope close.
      yield* Effect.addFinalizer(() =>
        ecs
          .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
          .pipe(Effect.ignore),
      );

      const deployService = () =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("WedgedVpc", { cidrBlock: "10.74.0.0/16" });
            const subnet = yield* Subnet("WedgedSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.74.1.0/24",
            });
            const cluster = yield* Cluster("WedgedCluster", {
              clusterName: "alchemy-test-ecs-service-wedged",
            });
            return yield* Service("WedgedService", {
              // Whole resource object, NOT a string ARN — the #736 shape.
              cluster,
              task: { taskDefinitionArn, containerName: "app", port: 80 },
              desiredCount: 0,
              vpcId: vpc.vpcId,
              subnets: [subnet.subnetId],
            });
          }),
        );

      const created = yield* deployService();

      // Rewrite the service's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and
      // every Output-valued prop lost in the round-trip.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) && r.row.resourceType === "AWS.ECS.Service",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no AWS.ECS.Service state row found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: wedged.fqn,
        value: {
          ...wedged.row,
          status: "creating",
          attr: undefined,
          props: {
            ...wedged.row.props,
            cluster: undefined,
            task: undefined,
            vpcId: undefined,
            subnets: undefined,
          },
        },
      });

      // Before the fix this crashed in plan with
      // `TypeError: undefined is not an object (evaluating 'cluster.clusterArn')`.
      const recovered = yield* deployService();
      expect(recovered.serviceArn).toEqual(created.serviceArn);
      expect(recovered.clusterArn).toEqual(created.clusterArn);

      yield* stack.destroy();
      yield* ecs
        .deregisterTaskDefinition({ taskDefinition: taskDefinitionArn })
        .pipe(Effect.catchTag("ClientException", () => Effect.void));
    }),
  { timeout: 240_000 },
);
