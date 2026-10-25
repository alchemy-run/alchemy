import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
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
  commands: [Unlock, Rename, Ping],
  decide: {
    Unlock: (_, cmd) => [new Unlocked({ minutes: cmd.minutes })],
    Rename: () => [],
    Ping: () => [],
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

class DoorApi extends Domain.Api("DoorApi", Unlock, Door, DoorState) {}

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
      const receipt = yield* api.Unlock({ target: DoorId.make("d-1"), minutes: 5 });
      expect(receipt.version).toBe(1);
      expect(yield* api.Door.get(DoorId.make("d-1"))).toEqual({ minutes: 5 });
      expect(
        yield* api.DoorState.get(DoorId.make("d-1"), {
          atLeast: { stream: receipt.stream, version: receipt.version },
        }),
      ).toEqual({ minutes: 5 });
    }).pipe(
      Effect.scoped,
      Effect.provide(Doors.layer(Layer.empty).pipe(Layer.provideMerge(InMemory))),
    ),
  );
});
