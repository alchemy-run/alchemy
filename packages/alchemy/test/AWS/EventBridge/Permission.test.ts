import * as AWS from "@/AWS";
import { EventBus } from "@/AWS/EventBridge/EventBus.ts";
import { Permission } from "@/AWS/EventBridge/Permission.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test. An EventBridge Permission is a statement in an event
// bus resource policy (there is no list-permissions API). `list()` enumerates
// every bus, parses each bus's Policy JSON, and emits one Attributes per Sid.
// Deploy a bus + a permission, resolve the provider via the typed
// `findProvider`, call `list()`, and assert the deployed statement appears.
test.provider("list enumerates the deployed permission", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const permission = yield* stack.deploy(
      Effect.gen(function* () {
        const bus = yield* EventBus("ListPermissionBus", {
          name: "alchemy-test-permission-list",
        });
        return yield* Permission("ListPermission", {
          eventBusName: bus.eventBusName,
          principal: "123456789012",
        });
      }),
    );

    const provider = yield* Provider.findProvider(Permission);
    const all = yield* provider.list();

    expect(
      all.some(
        (p) =>
          p.statementId === permission.statementId &&
          p.eventBusName === permission.eventBusName,
      ),
    ).toBe(true);

    yield* stack.destroy();
  }),
);
