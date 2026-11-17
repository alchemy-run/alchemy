import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const asyncWorkerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

// The tunnel and VPC service belong to another stack, as a lookup's target
// always should: a lookup of a service this stack manages fails the deploy.
const TargetStack = Alchemy.Stack(
  "VpcServiceLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const tunnel = yield* Cloudflare.Tunnel.Tunnel("RefTunnel", {
      ingress: [{ service: "http://localhost:8080" }],
      adopt: true,
    });
    const svc = yield* Cloudflare.VpcService.VpcService("RefSvc", {
      httpPort: 8080,
      host: {
        hostname: "localhost",
        resolverNetwork: { tunnelId: tunnel.tunnelId },
      },
      adopt: true,
    });
    return {
      serviceId: svc.serviceId.as<string>(),
      serviceName: svc.serviceName.as<string>(),
      httpPort: svc.httpPort.as<number | undefined>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

// Read the worker's live `vpc_service` bindings out-of-band from the script
// settings API.
const readVpcBindings = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    return (settings.bindings ?? []).filter(
      (b): b is Extract<typeof b, { type: "vpc_service" }> => b.type === "vpc_service",
    );
  });

test.provider(
  "looks up a vpc service by id/name and binds it to a worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const svc = yield* target;

      // Bind the service to a worker through lookups by id and by name. Both
      // emit a `vpc_service` binding. The lookups are also returned as stack
      // outputs, pinning plan-time Output resolution.
      const { byId, byName, worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("vpc-binding-worker", {
            script: asyncWorkerScript,
            env: {
              SVC_BY_ID: Cloudflare.VpcService.VpcService.lookup({
                serviceId: svc.serviceId,
              }),
              SVC_BY_NAME: Cloudflare.VpcService.VpcService.lookup({
                name: svc.serviceName,
              }),
            },
          });
          return {
            byId: Cloudflare.VpcService.VpcService.lookup({ serviceId: svc.serviceId }),
            byName: Cloudflare.VpcService.VpcService.lookup({ name: svc.serviceName }),
            worker,
          };
        }),
      );

      // The lookup resolves to the service's attributes.
      expect(byId.serviceId).toEqual(svc.serviceId);
      expect(byName.serviceId).toEqual(svc.serviceId);
      expect(byName.serviceName).toEqual(svc.serviceName);
      expect(byName.httpPort).toEqual(svc.httpPort);

      const vpc = yield* readVpcBindings(worker.workerName);
      expect(vpc.find((b) => b.name === "SVC_BY_ID")?.serviceId).toEqual(svc.serviceId);
      expect(vpc.find((b) => b.name === "SVC_BY_NAME")?.serviceId).toEqual(svc.serviceId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:tunnel",
      "provider:cloudflare:vpcservice",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);
