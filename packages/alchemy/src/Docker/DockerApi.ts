import type { Docker } from "./DockerClient.ts";

export interface ContainerRuntimeInfo {
  /**
   * Map of internal container ports to their bound host ports.
   * Format: `"80/tcp" -> 8080`.
   */
  ports: Record<string, number>;
}

export const toRuntimeInfo = (
  info: Docker.ContainerInfo,
): ContainerRuntimeInfo => {
  const ports: Record<string, number> = {};

  for (const [internal, bindings] of Object.entries(
    info.NetworkSettings.Ports ?? {},
  )) {
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort) ports[internal] = Number.parseInt(hostPort, 10);
  }

  for (const [internal, bindings] of Object.entries(
    info.HostConfig.PortBindings ?? {},
  )) {
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort && !(internal in ports)) {
      ports[internal] = Number.parseInt(hostPort, 10);
    }
  }

  return { ports };
};

export const parseRepoDigest = (
  imageRef: string,
  output: string,
): string | undefined => {
  const match = /digest:\s+([a-z0-9]+:[a-f0-9]{64})/i.exec(output);
  if (!match) return undefined;
  return `${repositoryFromImageRef(imageRef)}@${match[1]}`;
};

export const repositoryFromImageRef = (imageRef: string): string => {
  const withoutDigest = imageRef.includes("@")
    ? imageRef.slice(0, imageRef.indexOf("@"))
    : imageRef;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  const pathSeparator = withoutDigest.lastIndexOf("/");
  return tagSeparator > pathSeparator
    ? withoutDigest.slice(0, tagSeparator)
    : withoutDigest;
};

export const withRegistryHost = (
  imageRef: string,
  registry: { server: string },
): string => {
  const registryHost = registry.server.replace(/\/$/, "");
  const firstSegment = imageRef.split("/")[0];
  const hasRegistryPrefix =
    imageRef.includes("/") &&
    (firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment === "localhost");
  return hasRegistryPrefix ? imageRef : `${registryHost}/${imageRef}`;
};
