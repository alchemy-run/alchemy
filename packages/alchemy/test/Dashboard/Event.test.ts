/**
 * The engine → dashboard event adapter: every `Report.ApplyEvent` shape
 * lands on the dashboard vocabulary with its emission timestamp.
 */
import { fromApplyEvent } from "@/Dashboard/Event.ts";
import type { ApplyEvent } from "@/Report.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("dashboard event adapter", () => {
  it.effect("status events become status-change with the engine's fields", () =>
    Effect.sync(() => {
      const event: ApplyEvent = {
        _tag: "apply.resource.status",
        fqn: "ns/api",
        id: "api",
        type: "Cloudflare.Worker",
        status: "creating",
        message: "uploading",
        providerMode: "live",
        fromProviderMode: "local",
      };
      expect(fromApplyEvent(event, 42)).toEqual({
        kind: "status-change",
        ts: 42,
        fqn: "ns/api",
        id: "api",
        type: "Cloudflare.Worker",
        status: "creating",
        message: "uploading",
        providerMode: "live",
        fromProviderMode: "local",
      });
      // optional fields are omitted, not set to undefined (JSON-clean)
      const bare = fromApplyEvent(
        {
          _tag: "apply.resource.status",
          fqn: "a",
          id: "a",
          type: "T",
          status: "created",
        },
        7,
      );
      expect(bare).toEqual({
        kind: "status-change",
        ts: 7,
        fqn: "a",
        id: "a",
        type: "T",
        status: "created",
      });
      expect("message" in bare).toBe(false);
    }),
  );

  it.effect("notes become annotate; tool output streams as log lines", () =>
    Effect.sync(() => {
      expect(
        fromApplyEvent(
          { _tag: "apply.resource.note", fqn: "a", id: "a", message: "hi" },
          1,
        ),
      ).toEqual({ kind: "annotate", ts: 1, fqn: "a", id: "a", message: "hi" });
      expect(
        fromApplyEvent(
          {
            _tag: "apply.resource.note",
            fqn: "a",
            id: "a",
            message: "bundling…",
            kind: "status",
          },
          2,
        ),
      ).toEqual({
        kind: "annotate",
        ts: 2,
        fqn: "a",
        id: "a",
        message: "bundling…",
      });
      expect(
        fromApplyEvent(
          {
            _tag: "apply.resource.note",
            fqn: "a",
            id: "a",
            message: "> built in 12ms",
            kind: "output",
          },
          3,
        ),
      ).toEqual({
        kind: "log",
        ts: 3,
        fqn: "a",
        id: "a",
        level: "output",
        message: "> built in 12ms",
      });
    }),
  );
});
