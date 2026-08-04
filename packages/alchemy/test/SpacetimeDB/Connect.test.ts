import { connectEnvKeys } from "@/SpacetimeDB/Connect.ts";
import { DATABASE_NAME_RE } from "@/SpacetimeDB/Database.ts";
import { describe, expect, test } from "alchemy-test";

describe("connectEnvKeys", () => {
  test("single-word TitleCase logical IDs produce stable un-hashed keys", () => {
    // Canonical form is segments matching /^[A-Z][a-z0-9]*$/ (e.g. "Game"),
    // so compound camelCase like "GameDb" still gets a disambiguating hash.
    const keys = connectEnvKeys({ FQN: "Game", LogicalId: "Game" });
    expect(keys.uri).toBe("SPACETIMEDB_GAME_URI");
    expect(keys.databaseName).toBe("SPACETIMEDB_GAME_DATABASE_NAME");
    expect(keys.databaseIdentity).toBe("SPACETIMEDB_GAME_DATABASE_IDENTITY");
    expect(keys.host).toBe("SPACETIMEDB_GAME_HOST");
    expect(keys.dashboardUrl).toBe("SPACETIMEDB_GAME_DASHBOARD_URL");
  });

  test("arbitrary logical IDs are disambiguated with a hash suffix", () => {
    const a = connectEnvKeys({ FQN: "db-a", LogicalId: "db-a" });
    const b = connectEnvKeys({ FQN: "db_a", LogicalId: "db_a" });
    // Lossy normalization would collide; the hash keeps them distinct.
    expect(a.uri).not.toBe(b.uri);
    expect(a.uri.startsWith("SPACETIMEDB_")).toBe(true);
    expect(b.uri.startsWith("SPACETIMEDB_")).toBe(true);
  });

  test("nested FQNs prefer FQN over LogicalId", () => {
    const keys = connectEnvKeys({
      FQN: "Stack/GameDb",
      LogicalId: "GameDb",
    });
    expect(keys.uri).toContain("STACK_GAMEDB");
  });
});

describe("DATABASE_NAME_RE", () => {
  test("accepts valid SpacetimeDB names", () => {
    for (const name of ["a", "my-game", "chat-app-production", "test123"]) {
      expect(DATABASE_NAME_RE.test(name)).toBe(true);
    }
  });

  test("rejects invalid SpacetimeDB names", () => {
    for (const name of [
      "MyGame",
      "-leading",
      "trailing-",
      "has_underscore",
      "has space",
      "",
    ]) {
      expect(DATABASE_NAME_RE.test(name)).toBe(false);
    }
  });
});
