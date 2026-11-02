import { toRedisUrl } from "@alchemy.run/stackit/Valkey/RedisBinding";
import { describe, expect, it } from "@alchemy.run/test";

describe("toRedisUrl", () => {
  it("keeps a Redis URL, so its scheme decides TLS", () => {
    expect(toRedisUrl("redis://u:p@host:6379")).toEqual("redis://u:p@host:6379");
    expect(toRedisUrl("rediss://u:p@host:6380")).toEqual("rediss://u:p@host:6380");
  });

  it("reads a Valkey scheme as its Redis one, keeping TLS", () => {
    expect(toRedisUrl("valkey://u:p@host:6379")).toEqual("redis://u:p@host:6379");
    expect(toRedisUrl("valkeys://u:p@host:6380")).toEqual("rediss://u:p@host:6380");
  });

  it("refuses anything else rather than downgrade it", () => {
    expect(toRedisUrl("https://u:p@host:6379")).toBeUndefined();
    expect(toRedisUrl("host:6379")).toBeUndefined();
    expect(toRedisUrl("")).toBeUndefined();
  });
});
