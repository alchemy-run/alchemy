import { GatewayTimeout } from "@distilled.cloud/fly-io/Errors";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import { DeploymentRecoveryAmbiguous } from "@/Fly/bluegreen";
import { alchemyMetadataKeys as keys } from "@/Fly/Metadata";
import {
  ReplicaNotCreated,
  ReplicaRetirementIncomplete,
  retireMachines,
} from "@/Fly/replicas";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  appName,
  candidateId,
  metadata,
  protocolClient,
  reconcile,
  reply,
  withControlledClient,
} from "./fixtures/protocol-branches.ts";

it.live(
  "S07 P actual SDK GET 408 decoder returns typed GatewayTimeout, not genuine remote 408",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests++;
          expect(request.method).toBe("GET");
          expect(new URL(request.url).pathname).toBe(
            `/v1/apps/${appName}/machines/${candidateId}`,
          );
          return reply(request, { error: "controlled request timeout" }, 408);
        }),
      );
      const result = yield* machines
        .getMachine({ app_name: appName, machine_id: candidateId })
        .pipe(Retry.none, withControlledClient(client), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(GatewayTimeout);
        expect(result.failure._tag).toBe("GatewayTimeout");
        if (result.failure._tag === "GatewayTimeout")
          expect(result.failure.message).toBe("controlled request timeout");
      }
      expect(requests).toBe(1);
    }),
);

it.live(
  "F02 P delayed visibility readback reuses one candidate without replaying create",
  () =>
    Effect.gen(function* () {
      const fixture = yield* protocolClient({ conflict: true, hiddenLists: 2 });
      const result = yield* reconcile.pipe(
        withControlledClient(fixture.client),
      );
      expect(result.machineIds).toEqual([candidateId]);
      const lists = fixture.events.filter(
        (event) => event.visible !== undefined,
      );
      expect(lists.map((event) => event.visible)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      const creates = fixture.events.filter(
        (event) => event.method === "POST" && event.path.endsWith("/machines"),
      );
      expect(creates).toHaveLength(1);
      const visibleAt = fixture.events.indexOf(lists[3]!);
      const leaseAt = fixture.events.findIndex(
        (event) => event.method === "POST" && event.path.endsWith("/lease"),
      );
      const promotionAt = fixture.events.findIndex((event) =>
        event.path.endsWith("/uncordon"),
      );
      expect(leaseAt).toBeGreaterThan(visibleAt);
      expect(promotionAt).toBeGreaterThan(leaseAt);
      expect(
        fixture.events.filter((event) => event.phase === "active"),
      ).toHaveLength(1);
    }),
  { timeout: 30_000 },
);

it.live(
  "F02 P visibility exhaustion fails bounded readback without replay or promotion",
  () =>
    Effect.gen(function* () {
      const fixture = yield* protocolClient({
        conflict: true,
        hiddenLists: Infinity,
      });
      const result = yield* reconcile.pipe(
        withControlledClient(fixture.client),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toBeInstanceOf(ReplicaNotCreated);
      expect(
        fixture.events.filter(
          (event) =>
            event.method === "POST" && event.path.endsWith("/machines"),
        ),
      ).toHaveLength(1);
      // Initial observation, nine bounded readback attempts, and failure-path observation.
      expect(
        fixture.events.filter((event) => event.visible === false),
      ).toHaveLength(11);
      expect(
        fixture.events.some(
          (event) =>
            event.path.endsWith("/lease") ||
            event.path.endsWith("/uncordon") ||
            event.method === "DELETE",
        ),
      ).toBe(false);
    }),
  { timeout: 30_000 },
);

for (const missing of ["image_ref", "digest", "repository"] as const) {
  it.live(
    `S08 P missing ${missing} refuses candidate promotion through the controller`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* protocolClient({ missingImageRef: missing });
        const result = yield* reconcile.pipe(
          withControlledClient(fixture.client),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
          if (result.failure._tag === "Fly.DeploymentRecoveryAmbiguous") {
            expect(result.failure.appName).toBe(appName);
            expect(result.failure.message).toBe(
              `Candidate ${candidateId} changed before its lease was acquired. Mismatch: image_ref.`,
            );
          }
        }
        expect(
          fixture.events.some(
            (event) => event.method === "POST" && event.path.endsWith("/lease"),
          ),
        ).toBe(true);
        expect(
          fixture.events.some(
            (event) =>
              event.path.endsWith("/metadata") ||
              event.path.endsWith("/uncordon"),
          ),
        ).toBe(false);
        const current = yield* machines
          .getMachine({ app_name: appName, machine_id: candidateId })
          .pipe(withControlledClient(fixture.client));
        expect(current.cordoned).toBe(true);
        expect(current.config?.metadata?.[keys.phase]).toBe("candidate");
        if (missing === "image_ref") expect(current.image_ref).toBeUndefined();
        else expect(current.image_ref?.[missing]).toBeUndefined();
      }),
  );
}

const unreachable = (): machines.Machine => ({
  id: "controlled-unreachable",
  host_status: "unreachable",
  state: "started",
  config: { image: "fixture:latest", metadata, mounts: [] },
});

it.live(
  "F06 P owned stateless unreachable host skips lease/cordon/stop and force-deletes only with replacement ready",
  () =>
    Effect.gen(function* () {
      const target = unreachable();
      const events: Array<{
        method: string;
        path: string;
        force: string | undefined;
      }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          const path = url.pathname;
          events.push({
            method: request.method,
            path,
            force:
              request.urlParams.params.find(([key]) => key === "force")?.[1] ??
              url.searchParams.get("force") ??
              undefined,
          });
          if (
            request.method === "DELETE" &&
            path.endsWith(`/machines/${target.id}`)
          )
            return reply(request, {});
          if (request.method === "GET" && path.endsWith("/wait"))
            return reply(request, { error: "not found" }, 404);
          throw new Error(
            `Unexpected unreachable-host request: ${request.method} ${path}`,
          );
        }),
      );
      yield* retireMachines(appName, [target], true).pipe(
        withControlledClient(client),
      );
      expect(events).toEqual([
        {
          method: "DELETE",
          path: `/v1/apps/${appName}/machines/${target.id}`,
          force: "true",
        },
        {
          method: "GET",
          path: `/v1/apps/${appName}/machines/${target.id}/wait`,
          force: undefined,
        },
      ]);
    }),
);

const unsafe: Array<{ name: string; machine: () => machines.Machine }> = [
  {
    name: "missing config",
    machine: () => ({ ...unreachable(), config: undefined }),
  },
  {
    name: "incomplete config",
    machine: () => ({
      ...unreachable(),
      incomplete_config: { image: "fixture:latest" },
    }),
  },
  {
    name: "mounted config",
    machine: () => ({
      ...unreachable(),
      config: {
        metadata,
        mounts: [{ volume: "vol-controlled", path: "/data" }],
      },
    }),
  },
  {
    name: "missing ownership instance",
    machine: () => ({
      ...unreachable(),
      config: { metadata: { ...metadata, [keys.instance]: undefined } },
    }),
  },
  {
    name: "missing ownership FQN",
    machine: () => ({
      ...unreachable(),
      config: { metadata: { ...metadata, [keys.fqn]: undefined } },
    }),
  },
];

for (const variant of unsafe) {
  it.live(
    `F06 P unreachable host with ${variant.name} refuses force retirement`,
    () =>
      Effect.gen(function* () {
        let requests = 0;
        const client = HttpClient.make(() =>
          Effect.sync(() => {
            requests++;
            throw new Error(
              "Unsafe unreachable target must not reach the transport",
            );
          }),
        );
        const target = variant.machine();
        const result = yield* retireMachines(appName, [target], true).pipe(
          withControlledClient(client),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ReplicaRetirementIncomplete);
          if (result.failure._tag === "Fly.ReplicaRetirementIncomplete") {
            expect(result.failure.appName).toBe(appName);
            expect(result.failure.residuals).toEqual([
              { machineId: target.id, stage: "Fly.ReplicaOwnershipChanged" },
            ]);
          }
        }
        expect(requests).toBe(0);
      }),
  );
}

it.live(
  "F06 P unreachable host without replacement readiness cannot take the force-delete shortcut",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          events.push(`${request.method} ${path}`);
          if (request.method === "POST" && path.endsWith("/lease"))
            return reply(
              request,
              { error: "controlled host unavailable" },
              503,
            );
          throw new Error(
            `Unexpected unready retirement request: ${request.method} ${path}`,
          );
        }),
      );
      const result = yield* retireMachines(
        appName,
        [unreachable()],
        false,
      ).pipe(withControlledClient(client), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (
        Result.isFailure(result) &&
        result.failure._tag === "Fly.ReplicaRetirementIncomplete"
      ) {
        expect(result.failure.residuals).toEqual([
          { machineId: "controlled-unreachable", stage: "ServiceUnavailable" },
        ]);
      } else {
        throw new Error(
          "Expected exact retirement residual for unavailable lease acquisition",
        );
      }
      expect(events).toEqual([
        `POST /v1/apps/${appName}/machines/controlled-unreachable/lease`,
      ]);
    }),
);
