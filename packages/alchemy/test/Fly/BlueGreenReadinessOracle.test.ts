import type { Machine } from "@distilled.cloud/fly-io/machines";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertReadinessCommit,
  readinessChecksPassing,
  type ReadinessEvent,
} from "./fixtures/idle-cadence-readiness.ts";

const names = ["ready", "servicecheck-00-http-80"];
const reports = (mirror = false) =>
  [...names, ...(mirror ? ["bg_deployments_compat-00-http-80"] : [])].map(
    (name) => ({ name, status: "passing" }),
  );

// Synthetic journals exercise the oracle only; they are not native Fly evidence.
const trace = (idle = true, retry = false, mirror = false) => {
  const events: ReadinessEvent[] = [];
  const path = (slot: number) => `/v1/apps/oracle/machines/green-${slot}`;
  const metadata = (slot: number, phase: string): Record<string, string> => ({
    "alchemy.stack": "oracle",
    "alchemy.stage": "pure",
    "alchemy.id": "Worker",
    "alchemy.type": "Fly.Machine",
    "alchemy.instance": "resource-instance",
    "alchemy.fqn": "Worker",
    "alchemy.replica": String(slot),
    "alchemy.generation": "generation",
    "alchemy.workload": "workload",
    "alchemy.image": "nginx@sha256:fixture",
    "alchemy.phase": phase,
    "alchemy.readiness-role": "run",
    "alchemy.readiness-roles": "run,run",
    "alchemy.idle-policy-restored": "true",
    ...(phase === "active"
      ? { "alchemy.checked-instance": `instance-${slot}` }
      : {}),
  });
  const request = (input: Omit<ReadinessEvent, "stage" | "sequence">) => {
    const event: ReadinessEvent = {
      ...input,
      stage: "request",
      sequence: events.length,
    };
    events.push(event);
    return event;
  };
  const reply = (
    input: ReadinessEvent,
    fields: Partial<ReadinessEvent> = {},
  ) => {
    const event: ReadinessEvent = {
      ...input,
      stage: "forwarded",
      status: 200,
      ...fields,
    };
    events.push(event);
    return event;
  };
  const read = (slot: number, phase: string, state: string) =>
    reply(
      request({ method: "GET", path: path(slot), machineId: `green-${slot}` }),
      {
        instanceId: `instance-${slot}`,
        digest: "sha256:fixture",
        state,
        cordoned: false,
        phase,
        metadata: metadata(slot, phase),
        checks: state === "started" ? reports(mirror) : [],
        services: [
          {
            protocol: "tcp",
            port: 80,
            autostop: "stop",
            autostart: true,
            floor: 0,
          },
        ],
      },
    );
  const stamp = (slot: number, phase: string) => {
    const input = {
      method: "PUT",
      path: `${path(slot)}/metadata`,
      machineId: `green-${slot}`,
      phase,
      metadata: metadata(slot, phase),
      metadataOnly: true,
    };
    if (retry)
      reply(request(input), { status: phase === "active" ? 503 : 429 });
    reply(request(input));
  };
  for (const slot of [0, 1]) {
    reply(
      request({ method: "POST", path: path(slot), machineId: `green-${slot}` }),
    );
    read(slot, "promoting", "started");
  }
  for (const slot of [0, 1]) stamp(slot, "validating");
  for (const slot of [0, 1])
    read(slot, "validating", idle && slot === 0 ? "stopped" : "started");
  for (const slot of [1, 0]) stamp(slot, "active");
  request({
    method: "POST",
    path: "/v1/apps/oracle/machines/old/cordon",
    machineId: "old",
  });
  const candidates: Machine[] = [0, 1].map((slot) => ({
    id: `green-${slot}`,
    instance_id: `instance-${slot}`,
    image_ref: { digest: "sha256:fixture" },
    state: idle && slot === 0 ? "stopped" : "started",
    cordoned: false,
    config: {
      metadata: metadata(slot, "active"),
      services: [
        {
          protocol: "tcp",
          internal_port: 80,
          autostop: "stop",
          autostart: true,
          min_machines_running: 0,
        },
      ],
    },
  }));
  return { events, candidates };
};

it.effect(
  "pure readiness trace accepts rejected resume only with fresh started-instance proof",
  () =>
    Effect.sync(() => {
      const rejectedStart = (status: number) => {
        const value = trace(false);
        const request: ReadinessEvent = {
          sequence: 999,
          stage: "request",
          method: "POST",
          path: "/v1/apps/oracle/machines/green-0/start",
          machineId: "green-0",
        };
        value.events.splice(2, 0, request, {
          ...request,
          stage: "forwarded",
          status,
        });
        return value;
      };
      expect(() => check(rejectedStart(412))).not.toThrow();
      expect(() => check(rejectedStart(500))).toThrow();
      const missing = rejectedStart(412);
      for (const event of missing.events)
        if (event.method === "GET" && event.machineId === "green-0")
          event.state = "stopped";
      expect(() => check(missing)).toThrow();
    }),
);

type Trace = ReturnType<typeof trace>;
const check = ({ events, candidates }: Trace, allowIdle = true) =>
  assertReadinessCommit(events, ["old"], candidates, [0, 1], names, allowIdle);
const restored = ({ events }: Trace) =>
  events.find(
    (event) =>
      event.stage === "forwarded" &&
      event.method === "GET" &&
      event.machineId === "green-0" &&
      event.phase === "promoting",
  )!;
const pending = ({ events }: Trace) =>
  events.find(
    (event) =>
      event.stage === "forwarded" &&
      event.method === "GET" &&
      event.machineId === "green-0" &&
      event.phase === "validating",
  )!;
const active = ({ events }: Trace) =>
  events.filter(
    (event) =>
      event.method === "PUT" &&
      event.machineId === "green-0" &&
      event.phase === "active",
  );

it.effect(
  "pure readiness matcher permits only passing corresponding mirrors",
  () =>
    Effect.sync(() => {
      expect(readinessChecksPassing(reports(), names)).toBe(true);
      expect(readinessChecksPassing(reports(true), names)).toBe(true);
      for (const invalid of [
        undefined,
        [],
        reports(true).filter(
          (check) => check.name !== "servicecheck-00-http-80",
        ),
        [...reports(), reports()[0]!],
        [...reports(true), reports(true).at(-1)!],
        [...reports(), { name: "unrelated", status: "passing" }],
        [
          ...reports(),
          { name: "bg_deployments_compat-00-tcp-80", status: "passing" },
        ],
        [...reports(), { name: undefined, status: "passing" }],
        reports(true).map((check) => ({ ...check, status: "warning" })),
        reports(true).map((check) =>
          check.name.startsWith("bg_")
            ? { ...check, status: "critical" }
            : check,
        ),
      ])
        expect(readinessChecksPassing(invalid, names)).toBe(false);
      expect(readinessChecksPassing(reports(), [...names, names[0]!])).toBe(
        false,
      );
    }),
);

it.effect(
  "pure readiness traces accept running and restored-idle proof with settled metadata retries",
  () =>
    Effect.sync(() => {
      for (const idle of [false, true]) {
        for (const retry of [false, true]) check(trace(idle, retry, true));
      }
      const suspended = trace();
      pending(suspended).state = "suspended";
      suspended.candidates[0]!.state = "suspended";
      check(suspended);
    }),
);

const invalidTraces: [string, (value: Trace) => void][] = [
  [
    "missing restored passing proof",
    (value) => {
      restored(value).checks = [];
    },
  ],
  [
    "proof from another instance",
    (value) => {
      restored(value).instanceId = "obsolete";
    },
  ],
  [
    "proof from another workload",
    (value) => {
      restored(value).metadata!["alchemy.workload"] = "obsolete";
    },
  ],
  [
    "proof with the preparation service policy",
    (value) => {
      restored(value).services![0]!.autostop = "off";
    },
  ],
  [
    "created representative",
    (value) => {
      pending(value).state = "created";
    },
  ],
  [
    "configuration mutation after restored proof",
    (value) => {
      const index = value.events.indexOf(restored(value)) + 1;
      const event: ReadinessEvent = {
        sequence: 10_000,
        stage: "request",
        method: "POST",
        path: "/v1/apps/oracle/machines/green-0",
        machineId: "green-0",
      };
      value.events.splice(index, 0, event, {
        ...event,
        stage: "forwarded",
        status: 200,
      });
    },
  ],
  [
    "GET requested before restoration completed",
    (value) => {
      const response = restored(value);
      const index = value.events.findIndex(
        (event) => event.sequence === response.sequence,
      );
      const [request] = value.events.splice(index, 1);
      value.events.splice(1, 0, request!);
    },
  ],
  [
    "changed pending metadata after proof",
    (value) => {
      for (const event of value.events.filter(
        (event) =>
          event.method === "PUT" &&
          event.machineId === "green-0" &&
          event.phase === "validating",
      )) {
        event.metadata = {
          ...event.metadata,
          "alchemy.checked-instance": "unproven",
        };
      }
    },
  ],
  [
    "conflicting commit retry",
    (value) => {
      const retry = active(value)
        .filter((event) => event.stage === "request")
        .at(-1)!;
      retry.metadata = {
        ...retry.metadata,
        "alchemy.checked-instance": "other",
      };
    },
  ],
  [
    "unsettled rejected attempt",
    (value) => {
      value.events.splice(value.events.indexOf(active(value)[1]!), 1);
    },
  ],
  [
    "retry begins before rejected receipt",
    (value) => {
      const attempts = active(value);
      const index = value.events.indexOf(attempts[2]!);
      value.events.splice(index, 1);
      value.events.splice(value.events.indexOf(attempts[1]!), 0, attempts[2]!);
    },
  ],
  [
    "terminal commit rejection",
    (value) => {
      active(value).at(-1)!.status = 429;
    },
  ],
  [
    "nonretryable metadata rejection",
    (value) => {
      active(value)[1]!.status = 403;
    },
  ],
  [
    "duplicate successful commit",
    (value) => {
      active(value)[1]!.status = 200;
    },
  ],
  [
    "replica zero starts committing before the other commit settles",
    (value) => {
      const response = value.events.find(
        (event) =>
          event.machineId === "green-1" &&
          event.phase === "active" &&
          event.stage === "forwarded" &&
          event.status === 200,
      )!;
      value.events.splice(value.events.indexOf(response), 1);
      value.events.splice(
        value.events.indexOf(active(value)[0]!) + 1,
        0,
        response,
      );
    },
  ],
  [
    "retirement before terminal commit receipt",
    (value) => {
      const retirement = value.events.pop()!;
      value.events.splice(
        value.events.indexOf(active(value).at(-1)!),
        0,
        retirement,
      );
    },
  ],
  [
    "commit before complete topology validation",
    (value) => {
      const first = value.events.findIndex((event) => event.phase === "active");
      const commit = value.events.splice(first, 4);
      const validation = value.events.findIndex(
        (event) =>
          event.method === "GET" &&
          event.machineId === "green-1" &&
          event.stage === "forwarded" &&
          event.phase === "validating",
      );
      value.events.splice(validation - 1, 0, ...commit);
    },
  ],
];

for (const [name, corrupt] of invalidTraces) {
  it.effect(`pure readiness trace rejects ${name}`, () =>
    Effect.sync(() => {
      const value = trace(true, true);
      corrupt(value);
      expect(() => check(value)).toThrow();
    }),
  );
}

it.effect(
  "pure readiness trace refuses idle completion when autostop is disabled",
  () =>
    Effect.sync(() => {
      expect(() => check(trace(), false)).toThrow();
    }),
);
