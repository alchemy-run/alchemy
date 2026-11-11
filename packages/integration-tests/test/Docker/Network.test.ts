import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider(
  "diff replaces a network when labels change",
  () =>
    Effect.gen(function* () {
      const networkProvider = yield* Provider.findProvider(Docker.Network);
      const networkDiff = yield* networkProvider.diff!({
        id: "app",
        fqn: "app",
        instanceId: "instance",
        olds: { name: "app", labels: { usage: "old" } },
        news: { name: "app", labels: { usage: "new" } },
        oldBindings: [],
        newBindings: [],
        output: {
          id: "app",
          name: "app",
          driver: "bridge",
          internal: false,
          attachable: false,
          enableIPv4: true,
          enableIPv6: false,
          driverOpts: {},
          ipam: { driver: "default", options: {}, config: [] },
          labels: { usage: "old" },
          createdAt: 0,
        },
      });
      expect(networkDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:docker", "provider:docker:network", "local"] },
);

test.provider(
  "diff replaces a network when its Docker context changes",
  () =>
    Effect.gen(function* () {
      const networkProvider = yield* Provider.findProvider(Docker.Network);
      const networkDiff = yield* networkProvider.diff!({
        id: "app",
        fqn: "app",
        instanceId: "instance",
        olds: { name: "app", context: "default" },
        news: { name: "app", context: "remote-build" },
        oldBindings: [],
        newBindings: [],
        output: {
          id: "app",
          name: "app",
          driver: "bridge",
          internal: false,
          attachable: false,
          enableIPv4: true,
          enableIPv6: false,
          driverOpts: {},
          ipam: { driver: "default", options: {}, config: [] },
          labels: {},
          createdAt: 0,
        },
      });
      expect(networkDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:docker", "provider:docker:network", "local"] },
);

describe(
  "Docker.Network",
  { tags: ["provider:docker", "provider:docker:network", "local"], concurrent: false },
  () => {
    // Every prop is optional: `Docker.Network("app")` must plan, deploy,
    // redeploy in place, and destroy without a props object.
    test.provider("deploys a network declared without props", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        const first = yield* stack.deploy(Docker.Network("bare-network"));
        yield* expectFound(Docker.Network.lookup({ name: first.name }), first);
        const second = yield* stack.deploy(Docker.Network("bare-network"));
        expect(second.id).toBe(first.id);
        yield* stack.destroy();
        const gone = yield* docker.network.inspect(first.id).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    // Swarm caps overlay network names at 63 characters; a long logical id in
    // a long stack name must still produce a creatable name.
    test.provider("creates an overlay network under a long generated name", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* ensureDockerSwarm;
        yield* stack.destroy();
        const network = yield* stack.deploy(
          Docker.Network("an-overlay-network-with-a-rather-long-logical-identifier", {
            driver: "overlay",
          }),
        );
        expect(network.driver).toBe("overlay");
        expect(network.name.length).toBeLessThanOrEqual(63);
        const info = yield* docker.network.inspect(network.id);
        expect(info.Driver).toBe("overlay");
        yield* stack.destroy();
      }),
    );

    test.provider("creates a bridge network", (stack) =>
      Effect.gen(function* () {
        const network = yield* stack.deploy(
          Docker.Network("created-network", { labels: { "com.alchemy.test": "true" } }),
        );
        expect(network).toMatchObject({
          name: expect.any(String),
          driver: "bridge",
          id: expect.any(String),
          labels: { "com.alchemy.test": "true" },
        });
      }),
    );

    test.provider("creates an isolated attachable network with IPAM and driver options", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const resource = Docker.Network("configured-network", {
          internal: true,
          attachable: true,
          enableIPv4: true,
          driverOpts: {
            "com.docker.network.driver.mtu": "1420",
            "com.docker.network.bridge.enable_icc": "false",
          },
          ipam: {
            driver: "default",
            options: { testopt: "value" },
            config: [
              {
                subnet: "10.254.237.0/24",
                gateway: "10.254.237.1",
                ipRange: "10.254.237.128/25",
                auxAddresses: { reserved: "10.254.237.5" },
              },
            ],
          },
        });
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const created = yield* stack.deploy(resource);
        expect(created).toMatchObject({
          internal: true,
          attachable: true,
          enableIPv4: true,
          enableIPv6: false,
          driverOpts: {
            "com.docker.network.driver.mtu": "1420",
            "com.docker.network.bridge.enable_icc": "false",
          },
          ipam: {
            driver: "default",
            options: { testopt: "value" },
            config: [
              {
                subnet: "10.254.237.0/24",
                gateway: "10.254.237.1",
                ipRange: "10.254.237.128/25",
                auxAddresses: { reserved: "10.254.237.5" },
              },
            ],
          },
        });
        const info = yield* docker.network.inspect(created.id);
        expect(info.IPAM?.Config?.[0]?.Subnet).toBe("10.254.237.0/24");
        expect(info.IPAM?.Options?.testopt).toBe("value");
        expect((yield* stack.plan(resource)).resources["configured-network"]?.action).toBe("noop");
        expect((yield* stack.deploy(resource)).id).toBe(created.id);
      }),
    );

    test.provider("creates IPv6-only networks and preserves them on redeploy", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const resource = Docker.Network("ipv6-only-network", {
          enableIPv4: false,
          enableIPv6: true,
        });
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const first = yield* stack.deploy(resource);
        expect(first.enableIPv4).toBe(false);
        expect(first.enableIPv6).toBe(true);
        const info = yield* docker.network.inspect(first.id);
        expect(info.EnableIPv4).toBe(false);
        expect(info.EnableIPv6).toBe(true);
        expect((yield* stack.plan(resource)).resources["ipv6-only-network"]?.action).toBe("noop");
      }),
    );

    test.provider(
      "normalizes equivalent IPv6 IPAM addresses without replacing the network",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const resource = Docker.Network("canonical-ipv6-network", {
            enableIPv4: false,
            enableIPv6: true,
            ipam: {
              config: [
                {
                  subnet: "fd62:3456:789a:bcde:0000:0000:0000:0000/64",
                  gateway: "fd62:3456:789a:bcde:0000:0000:0000:0001",
                  ipRange: "fd62:3456:789a:bcde:8000:0000:0000:0000/65",
                  auxAddresses: { reserved: "fd62:3456:789a:bcde:0000:0000:0000:0005" },
                },
              ],
            },
          });
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const deployed = yield* stack.deploy(resource);
          const inspected = yield* docker.network.inspect(deployed.id);
          expect(inspected.IPAM?.Config?.[0]?.Subnet).toBe("fd62:3456:789a:bcde::/64");
          expect((yield* stack.plan(resource)).resources["canonical-ipv6-network"]?.action).toBe(
            "noop",
          );
          expect((yield* stack.deploy(resource)).id).toBe(deployed.id);
          const canonical = Docker.Network("canonical-ipv6-network", {
            enableIPv4: false,
            enableIPv6: true,
            ipam: {
              config: [
                {
                  subnet: "fd62:3456:789a:bcde::/64",
                  gateway: "fd62:3456:789a:bcde::1",
                  ipRange: "fd62:3456:789a:bcde:8000::/65",
                  auxAddresses: { reserved: "fd62:3456:789a:bcde::5" },
                },
              ],
            },
          });
          expect((yield* stack.plan(canonical)).resources["canonical-ipv6-network"]?.action).toBe(
            "update",
          );
          expect((yield* stack.deploy(canonical)).id).toBe(deployed.id);
          expect((yield* stack.plan(canonical)).resources["canonical-ipv6-network"]?.action).toBe(
            "noop",
          );
        }),
    );

    test.provider(
      "creates and redeploys overlay networks with multiple disjoint subnets",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const resource = Docker.Network("multi-subnet-overlay", {
            driver: "overlay",
            attachable: true,
            ipam: {
              config: [
                { subnet: "10.254.245.0/24", gateway: "10.254.245.254" },
                { subnet: "10.254.246.0/24", gateway: "10.254.246.254" },
              ],
            },
          });
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const deployed = yield* stack.deploy(resource);
          expect(deployed.ipam.config).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ subnet: "10.254.245.0/24", gateway: "10.254.245.254" }),
              expect.objectContaining({ subnet: "10.254.246.0/24", gateway: "10.254.246.254" }),
            ]),
          );
          expect((yield* stack.plan(resource)).resources["multi-subnet-overlay"]?.action).toBe(
            "noop",
          );
        }),
    );

    test.provider(
      "creates a dual-stack bridge network with explicit IPv4 and IPv6 subnets",
      (stack) =>
        Effect.gen(function* () {
          const resource = Docker.Network("dual-stack-bridge", {
            driver: "bridge",
            attachable: true,
            enableIPv4: true,
            enableIPv6: true,
            ipam: {
              config: [
                { subnet: "10.254.247.0/24", gateway: "10.254.247.254" },
                { subnet: "fd62:3456:789a:ffff::/64", gateway: "fd62:3456:789a:ffff::1" },
              ],
            },
          });
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const deployed = yield* stack.deploy(resource);
          expect(deployed.enableIPv4).toBe(true);
          expect(deployed.enableIPv6).toBe(true);
          expect(deployed.ipam.config).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ subnet: "10.254.247.0/24" }),
              expect.objectContaining({ subnet: "fd62:3456:789a:ffff::/64" }),
            ]),
          );
          expect((yield* stack.plan(resource)).resources["dual-stack-bridge"]?.action).toBe("noop");
          expect((yield* stack.deploy(resource)).id).toBe(deployed.id);
        }),
    );

    test.provider("replaces changed and removed IPAM or driver options", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const make = (subnet?: string, options?: Record<string, string>) =>
          Docker.Network("network-configuration-replace", {
            driverOpts: options,
            ipam:
              subnet === undefined
                ? undefined
                : {
                    config: [{ subnet, gateway: subnet.replace("0/24", "1") }],
                  },
          });
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const options = { "com.docker.network.bridge.enable_icc": "false" };
        const first = yield* stack.deploy(make("10.254.238.0/24", options));
        expect(
          (yield* stack.plan(make("10.254.238.0/24", options))).resources[
            "network-configuration-replace"
          ]?.action,
        ).toBe("noop");
        expect(
          (yield* stack.plan(make("10.254.239.0/24", options))).resources[
            "network-configuration-replace"
          ]?.action,
        ).toBe("replace");
        const second = yield* stack.deploy(make("10.254.239.0/24", options));
        expect(second.id).not.toBe(first.id);
        expect(second.ipam.config[0]?.subnet).toBe("10.254.239.0/24");

        expect(
          (yield* stack.plan(make(undefined, options))).resources["network-configuration-replace"]
            ?.action,
        ).toBe("replace");
        const third = yield* stack.deploy(make(undefined, options));
        expect(third.id).not.toBe(second.id);
        expect(
          (yield* stack.plan(make(undefined))).resources["network-configuration-replace"]?.action,
        ).toBe("replace");
        const fourth = yield* stack.deploy(make(undefined));
        expect(fourth.id).not.toBe(third.id);
        expect((yield* docker.network.inspect(fourth.id)).Options ?? {}).not.toHaveProperty(
          "com.docker.network.bridge.enable_icc",
        );
        expect(
          (yield* stack.plan(make(undefined))).resources["network-configuration-replace"]?.action,
        ).toBe("noop");
      }),
    );

    test.provider("rejects invalid network settings before invoking Docker", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const cases: { props: Docker.NetworkProps; path: string }[] = [
          { props: { enableIPv4: false }, path: "enableIPv4" },
          { props: { ipam: { config: [{ subnet: "" }] } }, path: "ipam.config[0].subnet" },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/99" }] } },
            path: "ipam.config[0].subnet",
          },
          {
            props: { ipam: { config: [{ subnet: "not-an-ip/24" }] } },
            path: "ipam.config[0].subnet",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.1/24" }] } },
            path: "ipam.config[0].subnet",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24", ipRange: "10.7.0.131/25" }] } },
            path: "ipam.config[0].ipRange",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24", gateway: "2001:db8::1" }] } },
            path: "ipam.config[0].gateway",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24", gateway: "10.7.1.1" }] } },
            path: "ipam.config[0].gateway",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24", ipRange: "10.7.1.0/24" }] } },
            path: "ipam.config[0].ipRange",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24", ipRange: "10.7.0.0/23" }] } },
            path: "ipam.config[0].ipRange",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24", ipRange: "10.7.0.128/99" }] } },
            path: "ipam.config[0].ipRange",
          },
          {
            props: {
              ipam: { config: [{ subnet: "10.7.0.0/24", auxAddresses: { foo: "invalid" } }] },
            },
            path: 'ipam.config[0].auxAddresses["foo"]',
          },
          {
            props: {
              ipam: { config: [{ subnet: "10.7.0.0/24", auxAddresses: { foo: "10.7.1.3" } }] },
            },
            path: 'ipam.config[0].auxAddresses["foo"]',
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24" }, { subnet: "10.7.0.0/24" }] } },
            path: "ipam.config[1].subnet",
          },
          {
            props: { ipam: { config: [{ subnet: "10.7.0.0/24" }, { subnet: "10.7.0.128/25" }] } },
            path: "ipam.config[1].subnet",
          },
          {
            props: {
              ipam: {
                config: [{ subnet: "fd12:abc::/64" }, { subnet: "fd12:abc:0:0:8000:0:0:0/65" }],
              },
              enableIPv6: true,
            },
            path: "ipam.config[1].subnet",
          },
          { props: { driverOpts: { "": "invalid" } }, path: 'driverOpts[""]' },
          {
            props: { labels: { "alchemy::id": "another-resource" } },
            path: 'labels["alchemy::id"]',
          },
          {
            props: { labels: { "alchemy::custom": "not-user-owned" } },
            path: 'labels["alchemy::custom"]',
          },
          { props: { ipam: { driver: "" } }, path: "ipam.driver" },
          { props: { ipam: { options: { "": "invalid" } } }, path: 'ipam.options[""]' },
          {
            props: {
              ipam: { config: [{ subnet: "10.7.0.0/24", auxAddresses: { "": "10.7.0.9" } }] },
            },
            path: 'ipam.config[0].auxAddresses[""]',
          },
          {
            props: { ipam: { config: [{ subnet: "fd12:3456:789a::/64" }] } },
            path: "ipam.config[0].subnet",
          },
          {
            props: {
              enableIPv4: false,
              enableIPv6: true,
              ipam: { config: [{ subnet: "10.7.0.0/24" }] },
            },
            path: "ipam.config[0].subnet",
          },
        ];
        const name = `alchemy-test-invalid-network-options-${stack.stage}`;
        for (const { props, path } of cases) {
          const error = yield* stack
            .deploy(Docker.Network("invalid-network-options", { ...props, name }))
            .pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
            );
          expect(error?._tag).toBe("InvalidNetworkOptions");
          expect(error).toMatchObject({ path, message: expect.stringContaining(path) });
          const missing = yield* docker.network.inspect(name).pipe(Effect.flip);
          expect(missing.reason._tag).toBe("NotFound");
        }
      }),
    );

    test.provider(
      "rejects malformed replacement settings without deleting the existing network",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = `alchemy-test-network-preserve-on-invalid-${stack.stage}`;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const previous = yield* stack.deploy(
            Docker.Network("preserve-on-invalid", { name, internal: true }),
          );
          const cases: { config: Docker.NetworkIpamConfig[]; path: string }[] = [
            { config: [{ subnet: "10.75.0.1/24" }], path: "ipam.config[0].subnet" },
            {
              config: [{ subnet: "10.75.0.0/24", gateway: "10.76.0.1" }],
              path: "ipam.config[0].gateway",
            },
            {
              config: [{ subnet: "10.75.0.0/24" }, { subnet: "10.75.0.128/25" }],
              path: "ipam.config[1].subnet",
            },
          ];
          for (const { config, path } of cases) {
            const invalid = Docker.Network("preserve-on-invalid", {
              name,
              internal: false,
              ipam: { config },
            });
            const planned = yield* stack.plan(invalid).pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
            );
            expect(planned?._tag).toBe("InvalidNetworkOptions");
            expect(planned).toMatchObject({ path, message: expect.stringContaining(path) });
            const deployed = yield* stack.deploy(invalid).pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
            );
            expect(deployed?._tag).toBe("InvalidNetworkOptions");
            expect(deployed).toMatchObject({ path, message: expect.stringContaining(path) });
            expect((yield* docker.network.inspect(previous.id)).Internal).toBe(true);
          }
        }),
    );

    test.provider(
      "rejects IPAM families disabled by network flags without deleting an existing network",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = `alchemy-test-network-preserve-families-${stack.stage}`;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const original = yield* stack.deploy(
            Docker.Network("preserve-families", { name, internal: true }),
          );
          const cases: Docker.NetworkProps[] = [
            { ipam: { config: [{ subnet: "fd12:3456:789a::/64" }] } },
            {
              enableIPv4: false,
              enableIPv6: true,
              ipam: { config: [{ subnet: "10.75.0.0/24" }] },
            },
          ];
          for (const props of cases) {
            const invalid = Docker.Network("preserve-families", {
              ...props,
              name,
              internal: false,
            });
            const planned = yield* stack.plan(invalid).pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
            );
            expect(planned?._tag).toBe("InvalidNetworkOptions");
            expect(planned).toMatchObject({ path: "ipam.config[0].subnet" });
            const deployed = yield* stack.deploy(invalid).pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
            );
            expect(deployed?._tag).toBe("InvalidNetworkOptions");
            expect(deployed).toMatchObject({ path: "ipam.config[0].subnet" });
            expect((yield* docker.network.inspect(original.id)).Internal).toBe(true);
          }
        }),
    );

    test.provider("rejects ownership label overrides without replacing a network", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-network-preserve-ownership-${stack.stage}`;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const original = yield* stack.deploy(
          Docker.Network("preserve-ownership", { name, labels: { environment: "test" } }),
        );
        const invalid = Docker.Network("preserve-ownership", {
          name,
          labels: { "alchemy::id": "spoofed-resource", environment: "production" },
        });
        const planned = yield* stack.plan(invalid).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
        );
        expect(planned?._tag).toBe("InvalidNetworkOptions");
        expect(planned).toMatchObject({ path: 'labels["alchemy::id"]' });
        const deployed = yield* stack.deploy(invalid).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findNetworkOptionsError(cause))),
        );
        expect(deployed?._tag).toBe("InvalidNetworkOptions");
        expect(deployed).toMatchObject({ path: 'labels["alchemy::id"]' });
        expect((yield* docker.network.inspect(original.id)).Labels?.environment).toBe("test");
      }),
    );

    test.provider("refuses a pre-existing network unless explicitly adopted", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const networkName = `alchemy-test-network-adoption-${stack.stage}`;
        yield* Effect.addFinalizer(() => docker.network.remove(networkName).pipe(Effect.ignore));
        yield* docker.network
          .remove(networkName)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
        yield* docker.network.create({ name: networkName, driver: "bridge" });

        const error = yield* stack
          .deploy(Docker.Network("existing-network", { name: networkName }))
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );
        expect(error?._tag).toBe("OwnedBySomeoneElse");

        const network = yield* stack.deploy(
          Docker.Network("existing-network", { name: networkName }).pipe(adopt(true)),
        );
        expect(network.name).toBe(networkName);
        expect(network.id.length).toBeGreaterThan(0);
      }),
    );

    test.provider("adopts an existing same-name network with stack adoption", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const networkName = `alchemy-test-network-adopt-existing-${stack.stage}`;
        yield* Effect.addFinalizer(() => docker.network.remove(networkName).pipe(Effect.ignore));
        yield* docker.network
          .remove(networkName)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
        yield* docker.network.create({ name: networkName, driver: "bridge" });

        const network = yield* stack.deploy(
          Docker.Network("existing-network", { name: networkName, driver: "bridge" }).pipe(
            adopt(true),
          ),
        );
        expect(network.name).toBe(networkName);
        expect(network.id.length).toBeGreaterThan(0);
      }),
    );

    test.provider(
      "adoption checks explicitly requested isolation before accepting the network",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = `alchemy-test-network-adopt-internal-${stack.stage}`;
          yield* docker.network
            .remove(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
          yield* Effect.addFinalizer(() => docker.network.remove(name).pipe(Effect.ignore));
          const original = yield* docker.network.create({ name, driver: "bridge" });
          const resource = Docker.Network("adopt-internal", { name, internal: true }).pipe(
            adopt(true),
          );
          const adopted = yield* stack.deploy(resource);
          expect(adopted.internal).toBe(true);
          expect((yield* docker.network.inspect(adopted.id)).Internal).toBe(true);
          expect(adopted.id).not.toBe(original.stdout);
        }),
    );

    test.provider("recreates a managed network removed outside Alchemy", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-network-out-of-band-deletion-${stack.stage}`;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Docker.Network("recover-deleted-network", { name });
        const original = yield* stack.deploy(resource);
        yield* docker.network.remove(original.id);
        expect((yield* stack.plan(resource)).resources["recover-deleted-network"]?.action).toBe(
          "update",
        );
        const recovered = yield* stack.deploy(resource);
        expect(recovered.id).not.toBe(original.id);
        expect((yield* docker.network.inspect(recovered.id)).Name).toBe(name);
        expect((yield* stack.plan(resource)).resources["recover-deleted-network"]?.action).toBe(
          "noop",
        );
      }),
    );

    test.provider("does not adopt a foreign network replacing a previously managed name", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-network-foreign-replacement-${stack.stage}`;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Docker.Network("ownership-replacement", { name });
        const original = yield* stack.deploy(resource);
        yield* docker.network.remove(original.id);
        const foreign = yield* docker.network.create({ name, driver: "bridge" });
        yield* Effect.addFinalizer(() => docker.network.remove(foreign.stdout).pipe(Effect.ignore));
        const planned = yield* stack.plan(resource).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
        expect(planned?._tag).toBe("OwnedBySomeoneElse");
        const deployed = yield* stack.deploy(resource).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
        expect(deployed?._tag).toBe("OwnedBySomeoneElse");
        // A changed immutable option takes the delete-first replacement path.
        // It must also reject the foreign owner before any destructive work.
        const replacement = yield* stack
          .deploy(Docker.Network("ownership-replacement", { name, internal: true }))
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );
        expect(replacement?._tag).toBe("OwnedBySomeoneElse");
        expect((yield* docker.network.inspect(foreign.stdout)).Id).toBe(foreign.stdout);
      }),
    );

    test.provider("replaces a network when its labels change", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-network-replace-${stack.stage}`;
        yield* docker.network
          .remove(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
        const first = yield* stack.deploy(
          Docker.Network("replaceable-network", { name, labels: { generation: "1" } }),
        );
        const second = yield* stack.deploy(
          Docker.Network("replaceable-network", { name, labels: { generation: "2" } }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
    );
  },
);

const findTagged = <Tag extends string, A extends { readonly _tag: Tag }>(
  cause: Cause.Cause<unknown>,
  tag: Tag,
): A | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is A =>
        typeof value === "object" && value !== null && "_tag" in value && value._tag === tag,
    );

const findOwnedError = (cause: Cause.Cause<unknown>) =>
  findTagged<"OwnedBySomeoneElse", OwnedBySomeoneElse>(cause, "OwnedBySomeoneElse");

const findNetworkOptionsError = (cause: Cause.Cause<unknown>) =>
  findTagged<"InvalidNetworkOptions", Docker.InvalidNetworkOptions>(cause, "InvalidNetworkOptions");
