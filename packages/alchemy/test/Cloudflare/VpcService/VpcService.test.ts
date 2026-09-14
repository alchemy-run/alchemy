import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, update, delete vpc service", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { tunnel, service } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        const service = yield* Cloudflare.VpcService.VpcService("VpcSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
        return { tunnel, service };
      }),
    );

    expect(service.serviceId).toBeDefined();
    expect(service.serviceType).toEqual("http");
    expect(service.httpPort).toEqual(8080);
    expect(service.host).toMatchObject({
      hostname: "localhost",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    });

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetched.serviceId).toEqual(service.serviceId);
    expect(fetched.httpPort).toEqual(8080);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService.VpcService("VpcSvc", {
          httpPort: 3000,
          httpsPort: 3001,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(updated.serviceId).toEqual(service.serviceId);
    expect(updated.httpPort).toEqual(3000);
    expect(updated.httpsPort).toEqual(3001);

    const fetchedUpdated = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetchedUpdated.httpPort).toEqual(3000);
    expect(fetchedUpdated.httpsPort).toEqual(3001);

    yield* stack.destroy();

    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

test.provider("create vpc service with ipv4 host", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("Ipv4Tunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService.VpcService("Ipv4Svc", {
          httpPort: 8080,
          host: {
            ipv4: "192.168.1.100",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(service.host).toMatchObject({
      ipv4: "192.168.1.100",
    });
    expect("ipv6" in service.host).toBe(false);

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect((fetched.host as { ipv4?: string }).ipv4).toEqual("192.168.1.100");

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

test.provider("create vpc service with dual-stack host", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DualStackTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService.VpcService("DualStackSvc", {
          httpPort: 8080,
          host: {
            ipv4: "192.168.1.101",
            ipv6: "2001:db8::1",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(service.host).toMatchObject({
      ipv4: "192.168.1.101",
      ipv6: "2001:db8::1",
    });

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed vpc service", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("ListTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService.VpcService("ListSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.VpcService.VpcService,
    );
    const all = yield* provider.list();

    const found = all.find((s) => s.serviceId === service.serviceId);
    expect(found).toBeDefined();
    expect(found?.serviceName).toEqual(service.serviceName);
    expect(found?.accountId).toEqual(accountId);

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

const waitForServiceToBeDeleted = Effect.fn(function* (
  serviceId: string,
  accountId: string,
) {
  yield* connectivity.getDirectoryService({ accountId, serviceId }).pipe(
    Effect.flatMap(() => Effect.fail(new VpcServiceStillExists())),
    Effect.retry({
      while: (e): e is VpcServiceStillExists =>
        e instanceof VpcServiceStillExists,
      schedule: Schedule.spaced("500 millis"),
      times: 8,
    }),
    Effect.catchTag("VpcServiceNotFound", () => Effect.void),
  );
});

class VpcServiceStillExists extends Data.TaggedError("VpcServiceStillExists") {}

test.provider(
  "creates and updates a TCP service with application protocol and TLS settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const program = (tcpPort: number) =>
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel.Tunnel("TcpTunnel", {});
          return yield* Cloudflare.VpcService.VpcService("TcpService", {
            serviceType: "tcp",
            tcpPort,
            appProtocol: "postgresql",
            tlsSettings: { certVerificationMode: "disabled" },
            host: {
              ipv4: "192.0.2.10",
              network: { tunnelId: tunnel.tunnelId },
            },
          });
        });
      const created = yield* stack.deploy(program(5432));
      const live = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: created.serviceId,
      });
      expect(live.type).toEqual("tcp");
      expect(live.tcpPort).toEqual(5432);
      expect(live.appProtocol).toEqual("postgresql");
      expect(live.tlsSettings?.certVerificationMode).toEqual("disabled");
      const invalid = yield* connectivity
        .updateDirectoryService({
          accountId,
          serviceId: created.serviceId,
          name: created.serviceName,
          type: "tcp",
          tcpPort: 5432,
          host: created.host,
          tlsSettings: { certVerificationMode: "none" },
        })
        .pipe(Effect.flip);
      expect(invalid._tag).toEqual("InvalidVpcServiceConfiguration");
      const updated = yield* stack.deploy(program(5433));
      expect(updated.serviceId).toEqual(created.serviceId);
      const changed = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: updated.serviceId,
      });
      expect(changed.tcpPort).toEqual(5433);
      yield* stack.destroy();
      yield* waitForServiceToBeDeleted(created.serviceId, accountId);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
