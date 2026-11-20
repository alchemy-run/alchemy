import { waitForComputeUrl } from "@alchemy.run/prisma/ComputeLifecycle";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

describe(
  "Prisma Compute URL checks",
  { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
  () => {
    it.live("accepts a streaming 200 response without consuming its body", () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          // Deliberately never enqueue or close. Reading this body would hang.
        },
      });
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
      );

      return waitForComputeUrl("https://app.prisma.build", {
        urlReadinessTimeoutSeconds: 0.05,
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
    });

    it.live("waits for the configured application health contract", () => {
      const requests: string[] = [];
      const http = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: requests.length === 1 ? 503 : 204 }),
          ),
        );
      });

      return Effect.gen(function* () {
        yield* waitForComputeUrl("https://app.prisma.build", {
          healthCheck: { path: "/api/health" },
          pollIntervalMs: 1,
          // Wall-clock deadline (live clock). The mock succeeds on the second
          // poll, so the pass path never waits this long — it only needs to
          // not fire spuriously when a saturated event loop (full-suite run)
          // delays the second poll beyond a tight budget.
          urlReadinessTimeoutSeconds: 30,
        });

        expect(requests).toEqual([
          "https://app.prisma.build/api/health",
          "https://app.prisma.build/api/health",
        ]);
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
    });

    it.effect("rejects unsafe application health contracts", () =>
      Effect.gen(function* () {
        const pathError = yield* waitForComputeUrl("https://app.prisma.build", {
          healthCheck: { path: "//attacker.example/health" },
        }).pipe(Effect.flip);
        const statusError = yield* waitForComputeUrl("https://app.prisma.build", {
          healthCheck: { path: "/health", statusCodes: [] },
        }).pipe(Effect.flip);

        expect(pathError.message).toContain("healthCheck.path");
        expect(statusError.message).toContain("healthCheck.statusCodes");
      }),
    );

    it.effect("fails closed when an application health probe cannot run", () =>
      Effect.gen(function* () {
        const props = {
          project: "project-1",
          serviceName: "api",
          healthCheck: { path: "/health" },
        } as const;
        const missingUrl = yield* waitForComputeUrl(undefined, props).pipe(Effect.flip);
        const missingRoutingUrl = yield* waitForComputeUrl(undefined, {}).pipe(Effect.flip);
        const disabled = yield* waitForComputeUrl("https://app.prisma.build", {
          ...props,
          verifyUrl: false,
        }).pipe(Effect.flip);
        const missingClient = yield* waitForComputeUrl("https://app.prisma.build", props).pipe(
          Effect.flip,
        );

        expect(missingUrl.message).toContain("did not return");
        expect(missingRoutingUrl.message).toContain("readiness verification");
        expect(disabled.message).toContain("verifyUrl: false");
        expect(missingClient.message).toContain("HTTP client");
      }),
    );

    it.live("observes health redirects without following them", () => {
      const redirects: RequestRedirect[] = [];
      const fetch = (async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        redirects.push(init?.redirect ?? "follow");
        return init?.redirect === "manual"
          ? new Response(null, { status: 302, headers: { location: "https://attacker.example/" } })
          : new Response(null, { status: 200 });
      }) as typeof globalThis.fetch;

      return Effect.gen(function* () {
        yield* waitForComputeUrl("https://app.prisma.build", {
          healthCheck: { path: "/health", statusCodes: [302] },
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.05,
        });
        const defaultStatusError = yield* waitForComputeUrl("https://app.prisma.build", {
          healthCheck: { path: "/health" },
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.01,
        }).pipe(Effect.flip);

        expect(redirects.length).toBeGreaterThanOrEqual(2);
        expect(redirects.every((redirect) => redirect === "manual")).toBe(true);
        expect(defaultStatusError.message).toContain("HTTP 302");
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    });

    it.live("enforces one deadline for stalled requests and 404 bodies", () => {
      const stalledRequest = HttpClient.make(() => Effect.never);
      const stalledBody = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                pull() {
                  // Deliberately never enqueue or close.
                },
              }),
              { status: 404 },
            ),
          ),
        ),
      );
      const props = {
        project: "project-1",
        serviceName: "api",
        pollIntervalMs: 1,
        urlReadinessTimeoutSeconds: 0.03,
      } as const;

      return Effect.gen(function* () {
        const requestError = yield* waitForComputeUrl("https://request.prisma.build", props).pipe(
          Effect.provide(Layer.succeed(HttpClient.HttpClient, stalledRequest)),
          Effect.flip,
        );
        const bodyError = yield* waitForComputeUrl("https://body.prisma.build", props).pipe(
          Effect.provide(Layer.succeed(HttpClient.HttpClient, stalledBody)),
          Effect.flip,
        );

        expect(requestError.message).toContain("Timed out");
        expect(bodyError.message).toContain("Timed out");
      });
    });

    it.live("bounds the inspected prefix of a large Prisma edge 404", () => {
      let requests = 0;
      const hugeBody = `${"There is no service on this URL"}${"x".repeat(256 * 1024)}`;
      const http = HttpClient.make((request) => {
        requests += 1;
        return requests === 1
          ? Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(hugeBody, { status: 404 })),
            )
          : Effect.never;
      });

      return Effect.gen(function* () {
        const error = yield* waitForComputeUrl("https://missing.prisma.build", {
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.05,
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)), Effect.flip);

        expect(error.message).toContain("There is no service on this URL");
        expect(requests).toBeGreaterThanOrEqual(1);
      });
    });

    it.effect("rejects invalid URL readiness timings before making a request", () => {
      const http = HttpClient.make(() => Effect.die("invalid readiness options must fail first"));

      return Effect.gen(function* () {
        const error = yield* waitForComputeUrl("https://app.prisma.build", {
          pollIntervalMs: 0,
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)), Effect.flip);

        expect(error.message).toContain("pollIntervalMs");
      });
    });
  },
);
