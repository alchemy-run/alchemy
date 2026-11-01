import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as alb from "@distilled.cloud/stackit/alb";
import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

/**
 * Application load balancers are billed per started hour, so a run costs each one
 * created a full hour (price list v1.0.44, EU01; Dedicated-10 EUR 0.0263/h, with
 * WAF Basic EUR 0.0288/h, public IP EUR 0.0041/h, g1.1 about EUR 0.03/h). Networks,
 * firewall configurations and IP lists are free.
 *
 * - lifecycle: one p10 and a public IP: EUR 0.031
 * - replacements: three p10 generations, each with an ephemeral IP: EUR 0.092
 * - private: one p10, no public IP: EUR 0.027
 * - firewall and block list: one p10 at the WAF price, an ephemeral IP: EUR 0.033
 * - traffic: one p10, a public IP, a g1.1 server and its boot volume: under EUR 0.07
 *
 * About EUR 0.25 per run, so the whole suite is gated behind the provider-wide
 * `STACKIT_TEST_SLOW`.
 */
const slow = !process.env.STACKIT_TEST_SLOW;

/** STACKIT's Terraform provider waits up to 90 minutes for a create. */
const options = { tags: stackitTags("alb", "loadbalancer"), timeout: 3_000_000 } as const;

const PLAN = "p10";
const HOST = "alchemy-test.example.com";

/** A second project this profile can create load balancers in. */
const otherProject = process.env.STACKIT_TEST_OTHER_PROJECT;

/** Out-of-band: the load balancer as STACKIT reports it, or `"gone"`. */
const observe = (projectId: string, region: string, name: string) =>
  alb
    .getLoadBalancer({ projectId, region, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

// The provider already waits for the delete; this absorbs read lag only.
const expectGone = (projectId: string, region: string, name: string) =>
  observe(projectId, region, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (loadBalancer) => loadBalancer === "gone",
      times: 12,
    }),
    Effect.map((loadBalancer) => expect(loadBalancer).toEqual("gone")),
  );

/** A network and an interface whose IP is a target, without booting a server. */
const targetNetwork = (prefix: string, logicalPrefix = "Alb") =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network(`${logicalPrefix}Network`, {
      ipv4: { prefix },
    });
    const nic = yield* Stackit.IaaS.NetworkInterface(`${logicalPrefix}Nic`, {
      networkId: network.networkId,
    });
    return { network, target: nic.ipv4.as<string>() };
  });

/** One HTTP listener sending `HOST` to the pool `web`. */
const httpListener = (port = 80) => ({
  name: "http",
  port,
  protocol: "PROTOCOL_HTTP" as const,
  http: { hosts: [{ host: HOST, rules: [{ targetPool: "web" }] }] },
});

test.provider.skipIf(slow)(
  "create, update and delete a load balancer on an existing public IP",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const lifecycle = (props: {
        port: number;
        apiPath?: string;
        allowedSourceRanges?: string[];
        labels: Record<string, string>;
      }) =>
        Effect.gen(function* () {
          const { network, target } = yield* targetNetwork("10.231.70.0/24");
          const address = yield* Stackit.IaaS.PublicIp("AlbAddress", {});
          const balancer = yield* Stackit.ALB.LoadBalancer("Lifecycle", {
            planId: PLAN,
            networks: [{ networkId: network.networkId }],
            externalAddress: address.ip,
            listeners: [
              {
                name: "http",
                port: props.port,
                protocol: "PROTOCOL_HTTP",
                http: {
                  hosts: [
                    {
                      host: HOST,
                      rules: [
                        ...(props.apiPath === undefined
                          ? []
                          : [{ targetPool: "web", path: { prefix: props.apiPath } }]),
                        { targetPool: "web", path: { prefix: "/" } },
                      ],
                    },
                  ],
                },
              },
            ],
            targetPools: [
              {
                name: "web",
                targetPort: 8080,
                targets: [{ displayName: "web-1", ip: target }],
                activeHealthCheck: {
                  interval: "10s",
                  timeout: "3s",
                  healthyThreshold: 2,
                  unhealthyThreshold: 3,
                },
              },
            ],
            ...(props.allowedSourceRanges === undefined
              ? {}
              : { options: { accessControl: { allowedSourceRanges: props.allowedSourceRanges } } }),
            labels: props.labels,
          });
          return { balancer, ip: address.ip };
        });

      const created = yield* stack.deploy(
        lifecycle({ port: 80, labels: { env: "test", keep: "yes" } }),
      );
      const name = created.balancer.loadBalancerName;
      expect(name).toMatch(/^[0-9a-z-]+$/);
      expect(created.balancer.status).toEqual("STATUS_READY");
      expect(created.balancer.planId).toEqual(PLAN);
      expect(created.balancer.externalAddress).toEqual(created.ip);
      expect(created.balancer.privateNetworkOnly).toEqual(false);
      expect(created.balancer.labels).toEqual({ env: "test", keep: "yes" });
      expect(created.balancer.projectId).toEqual(projectId);
      expect(created.balancer.region).toEqual(region);
      expect(created.balancer.version).toEqual(expect.any(String));

      // Out of band: the desired configuration and Alchemy's ownership labels.
      const fetched = yield* alb.getLoadBalancer({ projectId, region, name });
      expect(fetched.status).toEqual("STATUS_READY");
      expect(fetched.planId).toEqual(PLAN);
      expect(fetched.externalAddress).toEqual(created.ip);
      expect(fetched.listeners?.[0]).toMatchObject({
        name: "http",
        port: 80,
        protocol: "PROTOCOL_HTTP",
      });
      expect(fetched.listeners?.[0]?.http?.hosts?.[0]?.host).toEqual(HOST);
      expect(fetched.targetPools?.[0]?.targetPort).toEqual(8080);
      expect(fetched.targetPools?.[0]?.activeHealthCheck?.healthyThreshold).toEqual(2);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "Lifecycle",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(lifecycle({ port: 80, labels: { env: "test", keep: "yes" } }));
      expect(plan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // Update every mutable aspect in place: same name, same address.
      const updated = yield* stack.deploy(
        lifecycle({
          port: 8081,
          apiPath: "/api",
          allowedSourceRanges: ["203.0.113.0/24"],
          labels: { env: "prod", role: "web" },
        }),
      );
      expect(updated.balancer.loadBalancerName).toEqual(name);
      expect(updated.balancer.externalAddress).toEqual(created.ip);
      expect(updated.balancer.status).toEqual("STATUS_READY");
      expect(updated.balancer.labels).toEqual({ env: "prod", role: "web" });
      expect(updated.balancer.version).not.toEqual(created.balancer.version);

      const refetched = yield* alb.getLoadBalancer({ projectId, region, name });
      expect(refetched.listeners?.[0]?.port).toEqual(8081);
      expect(refetched.listeners?.[0]?.http?.hosts?.[0]?.rules?.length).toEqual(2);
      expect(refetched.options?.accessControl?.allowedSourceRanges).toEqual(["203.0.113.0/24"]);
      // Neighboring settings survive, and the removed `keep` label is gone.
      expect(refetched.targetPools?.[0]?.activeHealthCheck?.healthyThreshold).toEqual(2);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod", role: "web" });

      // Removing an option clears it: the update takes the full resource.
      const cleared = yield* stack.deploy(
        lifecycle({ port: 8081, apiPath: "/api", labels: { env: "prod", role: "web" } }),
      );
      expect(cleared.balancer.loadBalancerName).toEqual(name);
      const withoutAcl = yield* alb.getLoadBalancer({ projectId, region, name });
      expect(withoutAcl.options?.accessControl?.allowedSourceRanges ?? []).toEqual([]);

      // Nuke's enumeration finds it, with its attributes.
      const provider = yield* Provider.findProvider(Stackit.ALB.LoadBalancer);
      const all = yield* provider.list();
      expect(all.find((balancer) => balancer.loadBalancerName === name)?.planId).toEqual(PLAN);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a new name replaces create-first, a new network with the same name replaces delete-first",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // Both networks stay deployed through every step: the old network must not
      // be removed in the deploy that replaces the load balancer using it.
      const replaced = (name: string, onSecondNetwork: boolean) =>
        Effect.gen(function* () {
          const first = yield* targetNetwork("10.231.71.0/24", "AlbFirst");
          const second = yield* targetNetwork("10.231.72.0/24", "AlbSecond");
          const { network, target } = onSecondNetwork ? second : first;
          return yield* Stackit.ALB.LoadBalancer("Replaced", {
            name,
            planId: PLAN,
            networks: [{ networkId: network.networkId }],
            options: { ephemeralAddress: true },
            listeners: [httpListener()],
            targetPools: [{ name: "web", targetPort: 8080, targets: [{ ip: target }] }],
          });
        });

      const nameA = "alchemy-test-alb-replace-a";
      const nameB = "alchemy-test-alb-replace-b";

      const created = yield* stack.deploy(replaced(nameA, false));
      expect(created.loadBalancerName).toEqual(nameA);
      expect(created.ephemeralAddress).toEqual(true);
      expect(created.externalAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

      const renamePlan = yield* stack.plan(replaced(nameB, false));
      expect(renamePlan.resources.Replaced).toMatchObject({ action: "replace" });

      const renamed = yield* stack.deploy(replaced(nameB, false));
      expect(renamed.loadBalancerName).toEqual(nameB);
      yield* expectGone(projectId, region, nameA);

      // Same name on another network: the old generation goes first and is not
      // claimed by the new one.
      const moved = yield* stack.deploy(replaced(nameB, true));
      expect(moved.loadBalancerName).toEqual(nameB);
      expect(moved.networks[0]?.networkId).not.toEqual(renamed.networks[0]?.networkId);
      const fetched = yield* alb.getLoadBalancer({ projectId, region, name: nameB });
      expect(fetched.networks?.[0]?.networkId).toEqual(moved.networks[0]?.networkId);
      expect(fetched.status).toEqual("STATUS_READY");

      yield* stack.destroy();

      yield* expectGone(projectId, region, nameB);
    }).pipe(logLevel),
  options,
);

// Two more p10 generations with ephemeral IPs: about EUR 0.061.
test.provider.skipIf(slow || !otherProject)(
  "moving an explicit-name load balancer to a project where that name is taken is refused",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-alb-scope-move";
      const balancers = (moved: boolean) =>
        Effect.gen(function* () {
          const here = yield* Stackit.IaaS.Network("AlbScopeHere", {
            ipv4: { prefix: "10.231.75.0/24" },
          });
          const there = yield* Stackit.IaaS.Network("AlbScopeThere", {
            projectId: otherProject,
            ipv4: { prefix: "10.231.76.0/24" },
          });
          const shared = {
            name,
            planId: PLAN,
            options: { ephemeralAddress: true },
            listeners: [httpListener()],
          };
          // Another logical id stands in for someone else: its labels aren't this
          // resource's.
          const foreign = yield* Stackit.ALB.LoadBalancer("ForeignBalancer", {
            ...shared,
            projectId: otherProject,
            networks: [{ networkId: there.networkId }],
            targetPools: [{ name: "web", targetPort: 8080, targets: [{ ip: "10.231.76.10" }] }],
          });
          const balancer = yield* Stackit.ALB.LoadBalancer("MovedBalancer", {
            ...shared,
            projectId: moved ? otherProject : projectId,
            networks: [{ networkId: moved ? there.networkId : here.networkId }],
            targetPools: [
              {
                name: "web",
                targetPort: 8080,
                targets: [{ ip: moved ? "10.231.76.10" : "10.231.75.10" }],
              },
            ],
          });
          return { foreign, balancer };
        });

      yield* stack.deploy(balancers(false));

      const error = yield* stack.deploy(balancers(true)).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // The other load balancer still holds its own labels: nothing was written over it.
      const fetched = yield* alb.getLoadBalancer({ projectId: otherProject!, region, name });
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        "alchemy.id": "ForeignBalancer",
      });

      yield* stack.destroy();
      yield* expectGone(projectId, region, name);
      yield* expectGone(otherProject!, region, name);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a private load balancer has no public address and replaces to become public",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const privateLb = (privateNetworkOnly: boolean) =>
        Effect.gen(function* () {
          const { network, target } = yield* targetNetwork("10.231.73.0/24", "AlbPrivate");
          return yield* Stackit.ALB.LoadBalancer("Private", {
            planId: PLAN,
            networks: [{ networkId: network.networkId }],
            options: { privateNetworkOnly },
            listeners: [httpListener()],
            targetPools: [{ name: "web", targetPort: 8080, targets: [{ ip: target }] }],
          });
        });

      const created = yield* stack.deploy(privateLb(true));
      expect(created.privateNetworkOnly).toEqual(true);
      expect(created.externalAddress).toBeUndefined();

      const fetched = yield* alb.getLoadBalancer({
        projectId,
        region,
        name: created.loadBalancerName,
      });
      expect(fetched.options?.privateNetworkOnly).toEqual(true);
      expect(fetched.privateAddress).toMatch(/^10\.231\.73\./);

      // Only plans it, so this test pays for one load balancer.
      const plan = yield* stack.plan(privateLb(false));
      expect(plan.resources.Private).toMatchObject({ action: "replace" });

      yield* stack.destroy();

      yield* expectGone(projectId, region, created.loadBalancerName);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a firewall on a listener and a block list attach, and are released on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const rules = yield* Stackit.WAF.ManagedRuleSet("AlbOwasp", {});
          const firewall = yield* Stackit.WAF.Configuration("AlbFirewall", {
            managedRuleSetName: rules.ruleSetName,
          });
          const blocked = yield* Stackit.IPLists.IPList("AlbBlocked", {
            cidrs: ["198.51.100.0/24"],
          });
          const { network, target } = yield* targetNetwork("10.231.74.0/24", "AlbGuarded");
          const balancer = yield* Stackit.ALB.LoadBalancer("Guarded", {
            planId: PLAN,
            networks: [{ networkId: network.networkId }],
            options: {
              ephemeralAddress: true,
              accessControl: { ipBlockListName: blocked.listName },
            },
            listeners: [{ ...httpListener(), wafConfigName: firewall.configurationName }],
            targetPools: [{ name: "web", targetPort: 8080, targets: [{ ip: target }] }],
          });
          return { balancer, firewall, blocked };
        }),
      );

      const name = deployed.balancer.loadBalancerName;
      const fetched = yield* alb.getLoadBalancer({ projectId, region, name });
      expect(fetched.listeners?.[0]?.wafConfigName).toEqual(deployed.firewall.configurationName);
      expect(fetched.options?.accessControl?.ipBlockListName).toEqual(deployed.blocked.listName);

      // The firewall reports the listener using it.
      const live = yield* waf.getWAF({
        projectId,
        region,
        name: deployed.firewall.configurationName,
      });
      expect(live.usage?.items?.map((item) => item.loadBalancerName)).toContain(name);

      // Destroy order: the load balancer lets go first, or the rest are refused.
      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
      const firewall = yield* waf
        .getWAF({ projectId, region, name: deployed.firewall.configurationName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));
      expect(firewall).toEqual("gone");
    }).pipe(logLevel),
  { ...options, exclusive: "stackit:ip-lists" },
);

test.provider.skipIf(slow)(
  "routes real traffic by host to a server through the load balancer",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { items } = yield* iaas.listImages({ projectId, region, all: true });
      const imageId = items
        .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
        .sort((a, b) => b.name.localeCompare(a.name))[0]?.id;
      expect(imageId).toEqual(expect.any(String));

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Stackit.IaaS.Network("AlbTrafficNetwork", {
            ipv4: { prefix: "10.231.77.0/24" },
          });
          const nic = yield* Stackit.IaaS.NetworkInterface("AlbTrafficNic", {
            networkId: network.networkId,
          });
          yield* Stackit.IaaS.Server("AlbTrafficServer", {
            machineType: "g1.1",
            bootVolume: {
              size: 10,
              source: { type: "image", id: imageId! },
              deleteOnTermination: true,
            },
            networking: { networkInterfaceIds: [nic.networkInterfaceId] },
            userData: `#cloud-config
write_files:
  - path: /srv/www/index.html
    content: alchemy-application-load-balancer-test
runcmd:
  - [sh, -c, "cd /srv/www && nohup python3 -m http.server 8080 >/dev/null 2>&1 &"]
`,
          });
          const address = yield* Stackit.IaaS.PublicIp("AlbTrafficAddress", {});
          return yield* Stackit.ALB.LoadBalancer("Traffic", {
            planId: PLAN,
            networks: [{ networkId: network.networkId }],
            externalAddress: address.ip,
            listeners: [httpListener()],
            targetPools: [
              {
                name: "web",
                targetPort: 8080,
                targets: [{ displayName: "web-1", ip: nic.ipv4.as<string>() }],
              },
            ],
          });
        }),
      );

      // The load balancer the test just deployed is the user's own endpoint. The
      // server boots and the target turns healthy after the deploy returns.
      const text = yield* HttpClient.execute(
        HttpClientRequest.get(`http://${deployed.externalAddress}/`).pipe(
          HttpClientRequest.setHeader("host", HOST),
        ),
      ).pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200) return yield* Effect.fail(response.status);
            return yield* response.text;
          }),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
      );
      expect(text).toContain("alchemy-application-load-balancer-test");

      yield* stack.destroy();

      yield* expectGone(projectId, region, deployed.loadBalancerName);
    }).pipe(logLevel),
  options,
);
