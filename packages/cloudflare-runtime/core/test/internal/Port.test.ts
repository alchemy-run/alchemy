import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Port from "../../src/internal/Port.ts";
import * as PortHelpers from "../helpers/port.ts";

describe("Port.find", () => {
  it.effect("returns a free port when the requested port is 0", () =>
    Effect.gen(function* () {
      const ports = yield* Port.make({ cache: false });
      const port = yield* ports.find(0);
      expect(port).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("returns the requested port when free", () =>
    Effect.gen(function* () {
      const ports = yield* Port.make({ cache: false });
      const selected = yield* ports.find(0);
      const port = yield* ports.find(selected);
      expect(port).toBe(selected);
    }).pipe(it.flakyTest),
  );

  it.effect("skips a port in use and returns the next available one", () =>
    Effect.gen(function* () {
      const occupied = yield* PortHelpers.occupy(0);
      const ports = yield* Port.make({ cache: false });
      const next = yield* ports.find(occupied.port);
      expect(next).toBeGreaterThan(occupied.port);
    }),
  );
});
