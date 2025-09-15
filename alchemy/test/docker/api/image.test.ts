import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.ts";
import { BRANCH_PREFIX } from "../../util.ts";
// must import this or else alchemy.test won't exist
import {
  parseImageRef,
  parsePullConfig,
  parsePushConfig,
} from "../../../src/docker/api/image.ts";
import "../../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("parsePullConfig", () => {
  test("true | 'missing'", async () => {
    expect(parsePullConfig(true)).toMatchObject({
      enabled: true,
      force: false,
    });
    expect(parsePullConfig("missing")).toMatchObject({
      enabled: true,
      force: false,
    });
  });

  test("false | 'never'", async () => {
    expect(parsePullConfig(false)).toMatchObject({
      enabled: false,
      force: false,
    });
    expect(parsePullConfig("never")).toMatchObject({
      enabled: false,
      force: false,
    });
  });

  test("'always'", async () => {
    expect(parsePullConfig("always")).toMatchObject({
      enabled: true,
      force: true,
    });
  });

  describe("object", async () => {
    test("enabled = true, force = false by default", async () => {
      expect(parsePullConfig({})).toMatchObject({
        enabled: true,
        force: false,
      });
    });

    test("`force` overrides `policy`", async () => {
      expect(parsePullConfig({ policy: "always", force: false })).toMatchObject(
        {
          enabled: true,
          force: false,
        },
      );
    });

    test("`enabled` overrides `policy`", async () => {
      expect(
        parsePullConfig({ policy: "always", enabled: false }),
      ).toMatchObject({
        enabled: false,
        force: true,
      });
    });
  });
});

describe("parsePushConfig", () => {
  test("true | 'missing'", async () => {
    expect(parsePushConfig(true)).toMatchObject({
      enabled: true,
      force: false,
    });
    expect(parsePushConfig("missing")).toMatchObject({
      enabled: true,
      force: false,
    });
  });

  test("false | 'never'", async () => {
    expect(parsePushConfig(false)).toMatchObject({
      enabled: false,
      force: false,
    });
    expect(parsePushConfig("never")).toMatchObject({
      enabled: false,
      force: false,
    });
  });

  test("'always'", async () => {
    expect(parsePushConfig("always")).toMatchObject({
      enabled: true,
      force: true,
    });
  });

  describe("object", async () => {
    test("enabled = true, force = false by default", async () => {
      expect(parsePushConfig({})).toMatchObject({
        enabled: true,
        force: false,
      });
    });

    test("`force` overrides `policy`", async () => {
      expect(parsePushConfig({ policy: "always", force: false })).toMatchObject(
        {
          enabled: true,
          force: false,
        },
      );
    });

    test("`enabled` overrides `policy`", async () => {
      expect(
        parsePushConfig({ policy: "always", enabled: false }),
      ).toMatchObject({
        enabled: false,
        force: true,
      });
    });
  });
});

describe("parseImageRef", () => {
  test("should infer tag to latest if not provided", async () => {
    expect(parseImageRef("hello-world")).toEqual({
      registry: "docker.io",
      repository: "library/hello-world",
      tag: "latest",
      fqn: "docker.io/library/hello-world:latest",
    });
  });

  test("should parse tag if provided", async () => {
    expect(parseImageRef("hello-world:1.0.0")).toEqual({
      registry: "docker.io",
      repository: "library/hello-world",
      tag: "1.0.0",
      fqn: "docker.io/library/hello-world:1.0.0",
    });
  });

  test("should parse registry if provided", async () => {
    expect(parseImageRef("docker.io/hello-world:1.0.0")).toEqual({
      registry: "docker.io",
      repository: "library/hello-world",
      tag: "1.0.0",
      fqn: "docker.io/library/hello-world:1.0.0",
    });
  });

  test("should parse multi-segment repository", async () => {
    expect(
      parseImageRef("registry.alchemy.run/hello-world/hello-world:1.0.0"),
    ).toEqual({
      registry: "registry.alchemy.run",
      repository: "hello-world/hello-world",
      tag: "1.0.0",
      fqn: "registry.alchemy.run/hello-world/hello-world:1.0.0",
    });
  });

  test("should accept port in registry", async () => {
    expect(
      parseImageRef("registry.alchemy.run:5000/hello-world/hello-world:1.0.0"),
    ).toEqual({
      registry: "registry.alchemy.run:5000",
      repository: "hello-world/hello-world",
      tag: "1.0.0",
      fqn: "registry.alchemy.run:5000/hello-world/hello-world:1.0.0",
    });
  });

  test("should parse localhost as registry", async () => {
    expect(parseImageRef("localhost/hello-world/hello-world:1.0.0")).toEqual({
      registry: "localhost",
      repository: "hello-world/hello-world",
      tag: "1.0.0",
      fqn: "localhost/hello-world/hello-world:1.0.0",
    });

    expect(
      parseImageRef("localhost:5000/hello-world/hello-world:1.0.0"),
    ).toEqual({
      registry: "localhost:5000",
      repository: "hello-world/hello-world",
      tag: "1.0.0",
      fqn: "localhost:5000/hello-world/hello-world:1.0.0",
    });

    expect(parseImageRef("localhost/hello-world:1.0.0")).toEqual({
      registry: "localhost",
      repository: "hello-world",
      tag: "1.0.0",
      fqn: "localhost/hello-world:1.0.0",
    });

    expect(parseImageRef("localhost")).toEqual({
      registry: "docker.io",
      repository: "library/localhost",
      tag: "latest",
      fqn: "docker.io/library/localhost:latest",
    });

    expect(parseImageRef("localhost:1.0.0")).toEqual({
      registry: "docker.io",
      repository: "library/localhost",
      tag: "1.0.0",
      fqn: "docker.io/library/localhost:1.0.0",
    });
  });

  test("should parse digest if provided", async () => {
    expect(parseImageRef("hello-world@sha256:1234567890")).toEqual({
      registry: "docker.io",
      repository: "library/hello-world",
      digest: "sha256:1234567890",
      fqn: "docker.io/library/hello-world@sha256:1234567890",
    });
  });

  test("should throw error with invalid image reference", async () => {
    expect(() => parseImageRef("hello-world@sha256")).toThrow(
      /No digest part found./,
    );

    expect(() => parseImageRef("hello-world@sha256:1234567890")).not.toThrow();
    expect(() =>
      parseImageRef("hello-world:1.0.0@sha256:1234567890"),
    ).not.toThrow();

    expect(() => parseImageRef("hello-world:")).toThrow(/No tag part found./);
    expect(() => parseImageRef("hello-world:1.0.0@")).toThrow(
      /No digest part found./,
    );
    expect(() => parseImageRef("hello-world:1.0.0@sha256:")).toThrow(
      /No algorithm or hash part found./,
    );
  });

  test("should parse tag and digest", async () => {
    expect(parseImageRef("hello-world:1.0.0@sha256:1234567890")).toEqual({
      registry: "docker.io",
      repository: "library/hello-world",
      tag: "1.0.0",
      digest: "sha256:1234567890",
      fqn: "docker.io/library/hello-world:1.0.0@sha256:1234567890",
    });

    expect(parseImageRef("hello-world@sha256:1234567890")).toEqual({
      registry: "docker.io",
      repository: "library/hello-world",
      digest: "sha256:1234567890",
      fqn: "docker.io/library/hello-world@sha256:1234567890",
    });
  });
});
