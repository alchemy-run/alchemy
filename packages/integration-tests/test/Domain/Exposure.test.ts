import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- a door with a lock

const DoorId = Schema.String.pipe(Schema.brand("DoorId"));

class Unlocked extends Domain.Event("Unlocked", { minutes: Schema.Int }) {}

class Unlock extends Domain.Command("Unlock", {
  target: DoorId,
  input: { minutes: Schema.Int },
  events: [Unlocked],
  expose: { mcp: true, cli: false },
  // A long unlock needs a person to say yes when an agent asks for it.
  needsApproval: (call) => call.minutes > 60,
}) {}

class Wipe extends Domain.Command("Wipe", { target: DoorId, needsApproval: true }) {}

// The predicate sees what the Api decodes: a branded id and a `DateTime`.
const seen: Array<unknown> = [];
class Grant extends Domain.Command("Grant", {
  target: DoorId,
  input: { until: Schema.DateTimeUtcFromString },
  needsApproval: (call) => {
    seen.push(call);
    const target: typeof DoorId.Type = call.target;
    return target === "front" || DateTime.toEpochMillis(call.until) > Date.UTC(2027, 0, 1);
  },
}) {}

class Rename extends Domain.Command("Rename", {
  target: DoorId,
  input: { name: Schema.String },
  expose: { http: true },
}) {}

class Ping extends Domain.Command("Ping", { target: DoorId }) {}

class Door extends Domain.Aggregate("Door", {
  id: DoorId,
  state: Schema.Struct({ minutes: Schema.Int }),
  initial: { minutes: 0 },
  commands: [Unlock, Rename, Ping, Wipe, Grant],
  decide: {
    Unlock: (_, cmd) => [new Unlocked({ minutes: cmd.minutes })],
    Rename: () => [],
    Ping: () => [],
    Wipe: () => [],
    Grant: () => [],
  },
  evolve: { Unlocked: (_, e) => ({ minutes: e.minutes }) },
  read: { expose: { cli: false } },
}) {}

class DoorState extends Domain.View("DoorState", {
  from: [Door],
  key: Door,
  state: Schema.Struct({ minutes: Schema.Int }),
  initial: { minutes: 0 },
  evolve: { Unlocked: (_, e) => ({ minutes: e.minutes }) },
  expose: { http: true, mcp: false },
}) {}

class DoorChanged extends Domain.Event("DoorChanged", { minutes: Schema.Int }) {}

class DoorLog extends Domain.Stream("DoorLog", {
  key: Door,
  entries: [DoorChanged],
  expose: { cli: false },
}) {}

class Plain extends Domain.View("Plain", { from: [Door], key: Door }) {}

class Doors extends Domain.Model("Doors", { aggregates: [Door], views: [DoorState] }) {}

class DoorApi extends Domain.Api("DoorApi", Unlock, Wipe, Door, DoorState) {}

const defaults = { mcp: true, cli: true, http: false };

describe("Domain exposure", () => {
  it("reads the surfaces each kind of Api entry declares", () => {
    expect(Domain.exposureOf(Unlock)).toEqual({ mcp: true, cli: false, http: false });
    expect(Domain.exposureOf(Rename)).toEqual({ mcp: true, cli: true, http: true });
    expect(Domain.exposureOf(Door)).toEqual({ mcp: true, cli: false, http: false });
    expect(Domain.exposureOf(DoorState)).toEqual({ mcp: false, cli: true, http: true });
    expect(Domain.exposureOf(DoorLog)).toEqual({ mcp: true, cli: false, http: false });
  });

  it("an entry that declares nothing is on MCP and the CLI, and off public HTTP", () => {
    expect(Domain.exposureOf(Ping)).toEqual(defaults);
    expect(Domain.exposureOf(Plain)).toEqual(defaults);
  });

  it("refuses a surface it does not know", () => {
    class Unknown extends Domain.Command("Unknown", {
      target: DoorId,
      // @ts-expect-error mcp, cli and http are the surfaces
      expose: { grpc: true },
    }) {}
    expect(Unknown.tag).toBe("Unknown");
  });

  it.live("exposure changes nothing the Api serves", () =>
    Effect.gen(function* () {
      const api = yield* DoorApi.testClient;
      // A command that needs approval still runs here: enforcing it is a surface's job.
      yield* api.Wipe({ target: DoorId.make("d-1") });
      const receipt = yield* api.Unlock({ target: DoorId.make("d-1"), minutes: 90 });
      expect(receipt.version).toBe(1);
      expect(yield* api.Door.get(DoorId.make("d-1"))).toEqual({ minutes: 90 });
      expect(
        yield* api.DoorState.get(DoorId.make("d-1"), {
          atLeast: { stream: receipt.stream, version: receipt.version },
        }),
      ).toEqual({ minutes: 90 });
    }).pipe(
      Effect.scoped,
      Effect.provide(Doors.layer(Layer.empty).pipe(Layer.provideMerge(InMemory))),
    ),
  );
});

describe("Domain approval", () => {
  const door = DoorId.make("d-1");

  it("a command that declares true needs approval for every call", () => {
    expect(Domain.needsApproval(Wipe, { target: door })).toBe(true);
    expect(Wipe.needsApproval).toBe(true);
  });

  it("a predicate decides per call", () => {
    expect(Domain.needsApproval(Unlock, { target: door, minutes: 5 })).toBe(false);
    expect(Domain.needsApproval(Unlock, { target: door, minutes: 90 })).toBe(true);
  });

  it("an entry that declares nothing, and every read, needs no approval", () => {
    expect(Domain.needsApproval(Ping, { target: door })).toBe(false);
    expect(Ping.needsApproval).toBe(false);
    expect(Domain.needsApproval(Door, { key: door })).toBe(false);
    expect(Domain.needsApproval(DoorState, { key: door })).toBe(false);
    expect(Domain.needsApproval(DoorLog, { key: door })).toBe(false);
  });

  it("the predicate gets the input as the Api decodes it", () => {
    const decode = Schema.decodeUnknownSync(Grant.rpc.payloadSchema);
    const soon = decode({ target: "d-1", until: "2026-11-01T00:00:00.000Z" });
    const late = decode({ target: "d-1", until: "2027-06-01T00:00:00.000Z" });
    expect(Domain.needsApproval(Grant, soon)).toBe(false);
    expect(Domain.needsApproval(Grant, late)).toBe(true);
    expect(
      Domain.needsApproval(Grant, decode({ target: "front", until: "2026-11-01T00:00:00.000Z" })),
    ).toBe(true);
    expect(DateTime.isDateTime((seen[0] as { until: unknown }).until)).toBe(true);
  });

  it("types the call, and refuses approval on a read", () => {
    // @ts-expect-error the call has the command's fields
    Domain.needsApproval(Unlock, { target: door, minutes: "5" });
    class Typed extends Domain.Command("Typed", {
      target: DoorId,
      input: { minutes: Schema.Int },
      // @ts-expect-error the predicate reads the command's fields only
      needsApproval: (call) => call.hours > 1,
    }) {}
    class ApprovedView extends Domain.View("ApprovedView", {
      from: [Door],
      key: Door,
      // @ts-expect-error a read needs no approval
      needsApproval: true,
    }) {}
    class ApprovedStream extends Domain.Stream("ApprovedStream", {
      key: Door,
      entries: [DoorChanged],
      // @ts-expect-error a read needs no approval
      needsApproval: true,
    }) {}
    class ApprovedRead extends Domain.Aggregate("ApprovedRead", {
      id: DoorId,
      state: Schema.Struct({}),
      initial: {},
      commands: [],
      decide: {},
      evolve: {},
      // @ts-expect-error a read needs no approval
      read: { needsApproval: true },
    }) {}
    expect([
      Typed.tag,
      ApprovedView.viewName,
      ApprovedStream.streamName,
      ApprovedRead.aggregateName,
    ]).toEqual(["Typed", "ApprovedView", "ApprovedStream", "ApprovedRead"]);
  });
});
