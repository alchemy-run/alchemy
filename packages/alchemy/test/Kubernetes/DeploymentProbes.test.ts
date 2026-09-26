import { havePropsChanged } from "@/Diff.ts";
import { KubeConfig } from "@/Kubernetes/Connection.ts";
import type { DeploymentProps } from "@/Kubernetes/Deployment.ts";
import { withProbePort } from "@/Kubernetes/internal/workload.ts";
import { describe, expect, it } from "alchemy-test";

describe("Kubernetes.Deployment probes", () => {
  it("leaves an omitted probe undefined", () => {
    expect(withProbePort(undefined, 8080)).toBeUndefined();
  });

  it("defaults each handler port to the container port", () => {
    expect(
      withProbePort(
        {
          httpGet: { path: "/healthz" },
          initialDelaySeconds: 3,
          periodSeconds: 10,
          failureThreshold: 3,
        },
        8080,
      ),
    ).toEqual({
      httpGet: { path: "/healthz", port: 8080 },
      initialDelaySeconds: 3,
      periodSeconds: 10,
      failureThreshold: 3,
    });
    expect(withProbePort({ tcpSocket: {}, periodSeconds: 5 }, 8080)).toEqual({
      tcpSocket: { port: 8080 },
      periodSeconds: 5,
    });
    expect(withProbePort({ grpc: { service: "health" } }, 8080)).toEqual({
      grpc: { service: "health", port: 8080 },
    });
  });

  it("keeps an explicit handler port", () => {
    expect(
      withProbePort(
        { httpGet: { path: "/ready", port: "metrics", scheme: "HTTPS" } },
        8080,
      ),
    ).toEqual({
      httpGet: { path: "/ready", port: "metrics", scheme: "HTTPS" },
    });
    expect(withProbePort({ tcpSocket: { port: 9000 } }, 8080)).toEqual({
      tcpSocket: { port: 9000 },
    });
    expect(withProbePort({ grpc: { port: 9090 } }, 8080)).toEqual({
      grpc: { port: 9090 },
    });
  });

  it("passes exec probes through without a port", () => {
    expect(
      withProbePort({ exec: { command: ["cat", "/tmp/ready"] } }, 8080),
    ).toEqual({ exec: { command: ["cat", "/tmp/ready"] } });
  });

  it("reports a probe change as a props change (update)", () => {
    const base: DeploymentProps = {
      cluster: KubeConfig({ context: "test" }),
      image: "nginx:1.27",
    };
    const withProbe: DeploymentProps = {
      ...base,
      readinessProbe: { httpGet: { path: "/healthz" } },
    };
    const tuned: DeploymentProps = {
      ...base,
      readinessProbe: { httpGet: { path: "/healthz" }, periodSeconds: 5 },
    };
    expect(havePropsChanged(base, withProbe)).toBe(true);
    expect(havePropsChanged(withProbe, tuned)).toBe(true);
    expect(havePropsChanged(withProbe, { ...withProbe })).toBe(false);
  });
});
