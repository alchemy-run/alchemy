import { Connect, connectEnvKeys } from "@/SpacetimeDB/Connect.ts";
import { SpacetimeDBCredentials } from "@/SpacetimeDB/Credentials.ts";
import { SpacetimeCliError } from "@/SpacetimeDB/Cli.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

describe("connectEnvKeys", () => {
  it("includes the token key", () => {
    const keys = connectEnvKeys({
      FQN: "Todos",
      LogicalId: "Todos",
    } as any);
    expect(keys.token).toBe("SPACETIMEDB_TODOS_TOKEN");
  });
});

describe("Connect binding shape", () => {
  it("exports a Connect tag with the right identifier", () => {
    expect(Connect.key).toBe("SpacetimeDB.Connect");
  });
});
