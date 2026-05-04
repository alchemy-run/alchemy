import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete tunnel with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("DefaultTunnel");
      }),
    );

    expect(tunnel.tunnelId).toBeDefined();
    expect(tunnel.tunnelName).toBeDefined();
    expect(tunnel.configSrc).toEqual("cloudflare");
    expect(Redacted.value(tunnel.token).length).toBeGreaterThan(0);

    const actualTunnel = yield* zeroTrust.getTunnelCloudflared({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(actualTunnel.id).toEqual(tunnel.tunnelId);
    expect(actualTunnel.name).toEqual(tunnel.tunnelName);

    yield* stack.destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete tunnel with ingress", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("WebTunnel", {
          ingress: [
            { hostname: "test.example.com", service: "http://localhost:8080" },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(tunnel.tunnelId).toBeDefined();

    const config = yield* zeroTrust.getTunnelCloudflaredConfiguration({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(config.config?.ingress?.length).toEqual(2);
    expect(config.config?.ingress?.[0].hostname).toEqual("test.example.com");
    expect(config.config?.ingress?.[0].service).toEqual(
      "http://localhost:8080",
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("WebTunnel", {
          ingress: [
            { hostname: "app.example.com", service: "http://localhost:3000" },
            {
              hostname: "api.example.com",
              service: "http://localhost:8080",
              originRequest: {
                httpHostHeader: "api.internal",
                connectTimeout: 30,
              },
            },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(updated.tunnelId).toEqual(tunnel.tunnelId);

    const updatedConfig = yield* zeroTrust.getTunnelCloudflaredConfiguration({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(updatedConfig.config?.ingress?.length).toEqual(3);
    expect(updatedConfig.config?.ingress?.[1].originRequest).toMatchObject({
      httpHostHeader: "api.internal",
      connectTimeout: 30,
    });

    yield* stack.destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(logLevel),
);

test.provider("local configuration mode skips configuration", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("LocalTunnel", {
          configSrc: "local",
          ingress: [
            { hostname: "test.example.com", service: "http://localhost:3000" },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(tunnel.configSrc).toEqual("local");

    yield* stack.destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(logLevel),
);

const waitForTunnelToBeDeleted = Effect.fn(function* (
  tunnelId: string,
  accountId: string,
) {
  yield* zeroTrust.getTunnelCloudflared({ accountId, tunnelId }).pipe(
    Effect.flatMap((t) =>
      t.deletedAt ? Effect.void : Effect.fail(new TunnelStillExists()),
    ),
    Effect.retry({
      while: (e): e is TunnelStillExists => e instanceof TunnelStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catch(() => Effect.void),
  );
});

class TunnelStillExists extends Data.TaggedError("TunnelStillExists") {}
