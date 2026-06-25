import {
  buildContainerCreateCommand,
  buildImageBuildArgs,
  buildNetworkCreateArgs,
  buildVolumeCreateArgs,
  parseRepoDigest,
  repositoryFromImageRef,
  toRuntimeInfo,
  withRegistryHost,
} from "@/Docker/DockerApi";
import { desiredImageRef, localImageRef } from "@/Docker/Image";
import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

describe("Docker CLI helpers", () => {
  it("builds volume create argv", () => {
    expect(
      buildVolumeCreateArgs({
        name: "data",
        driver: "local",
        driverOpts: { type: "nfs" },
        labels: { usage: "test" },
      }),
    ).toEqual([
      "volume",
      "create",
      "--name",
      "data",
      "--driver",
      "local",
      "--opt",
      "type=nfs",
      "--label",
      "usage=test",
    ]);
  });

  it("builds network create argv", () => {
    expect(
      buildNetworkCreateArgs({
        name: "app",
        driver: "bridge",
        enableIPv6: true,
        labels: { app: "alchemy" },
      }),
    ).toEqual([
      "network",
      "create",
      "--driver",
      "bridge",
      "--ipv6",
      "--label",
      "app=alchemy",
      "app",
    ]);
  });

  it("builds image build argv with v1 options", () => {
    expect(
      buildImageBuildArgs({
        tag: "app:latest",
        context: "/tmp/app",
        dockerfile: "/tmp/app/Dockerfile",
        platform: "linux/amd64",
        target: "runner",
        args: { NODE_ENV: "production" },
        cacheFrom: ["type=registry,ref=example/app:cache"],
        cacheTo: ["type=inline"],
        options: ["--pull"],
      }),
    ).toEqual([
      "build",
      "-t",
      "app:latest",
      "--platform",
      "linux/amd64",
      "--target",
      "runner",
      "--cache-from",
      "type=registry,ref=example/app:cache",
      "--cache-to",
      "type=inline",
      "--build-arg",
      "NODE_ENV=production",
      "--pull",
      "-f",
      "/tmp/app/Dockerfile",
      "/tmp/app",
    ]);
  });

  it("keeps Redacted container env values out of argv", () => {
    const command = buildContainerCreateCommand({
      image: "postgres:16",
      name: "db",
      environment: {
        POSTGRES_PASSWORD: Redacted.make("super-secret"),
      },
      ports: [{ external: 5432, internal: 5432 }],
      volumes: [
        { hostPath: "db-data", containerPath: "/var/lib/postgresql/data" },
      ],
      restart: "unless-stopped",
      healthcheck: {
        cmd: "pg_isready",
        interval: "5s",
      },
    });

    expect(command.args).toContain("--env");
    expect(command.args).toContain("POSTGRES_PASSWORD");
    expect(command.args.join(" ")).not.toContain("super-secret");
    expect(command.env?.POSTGRES_PASSWORD).toBe("super-secret");
  });

  it("parses runtime port mappings from NetworkSettings and HostConfig fallback", () => {
    expect(
      toRuntimeInfo({
        Id: "abc",
        Created: new Date().toISOString(),
        State: { Status: "running" },
        Config: { Image: "nginx", Cmd: null, Env: null },
        HostConfig: {
          Binds: null,
          RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
          AutoRemove: false,
          PortBindings: {
            "81/tcp": [{ HostIp: "0.0.0.0", HostPort: "8081" }],
          },
        },
        NetworkSettings: {
          Networks: {},
          Ports: {
            "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
          },
        },
      }),
    ).toEqual({ ports: { "80/tcp": 8080, "81/tcp": 8081 } });
  });

  it("normalizes registry push refs and parses repo digest", () => {
    expect(withRegistryHost("app:latest", { server: "ghcr.io" })).toBe(
      "ghcr.io/app:latest",
    );
    expect(
      withRegistryHost("localhost:5000/app:latest", { server: "ghcr.io" }),
    ).toBe("localhost:5000/app:latest");
    expect(
      parseRepoDigest(
        "localhost:5000/app:latest",
        "latest: digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa size: 123",
      ),
    ).toBe(
      "localhost:5000/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("parses image repositories without confusing registry ports for tags", () => {
    expect(repositoryFromImageRef("nginx:alpine")).toBe("nginx");
    expect(repositoryFromImageRef("ghcr.io/acme/app:latest")).toBe(
      "ghcr.io/acme/app",
    );
    expect(repositoryFromImageRef("localhost:5000/acme/app:latest")).toBe(
      "localhost:5000/acme/app",
    );
    expect(
      repositoryFromImageRef(
        "localhost:5000/acme/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBe("localhost:5000/acme/app");
    expect(
      localImageRef("retagged", {
        image: "localhost:5000/acme/app:old",
        tag: "new",
      }),
    ).toBe("localhost:5000/acme/app:new");
    expect(
      desiredImageRef("retagged", {
        image: "localhost:5000/acme/app:old",
        tag: "new",
        registry: {
          server: "ghcr.io",
          username: "octocat",
          password: Redacted.make("token"),
        },
      }),
    ).toBe("localhost:5000/acme/app:new");
    expect(
      desiredImageRef("retagged", {
        image: "acme/app:old",
        tag: "new",
        registry: {
          server: "ghcr.io",
          username: "octocat",
          password: Redacted.make("token"),
        },
      }),
    ).toBe("ghcr.io/acme/app:new");
  });
});
