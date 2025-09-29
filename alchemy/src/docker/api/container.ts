import type Dockerode from "dockerode";
import type { Context } from "../../context.ts";
import { Resource } from "../../resource.ts";
import { DockerHost } from "./docker-host.ts";
import type { DockerRegistry } from "./docker-registry.ts";

export interface ContainerProps {
  dockerHost?: DockerHost<Record<string, DockerRegistry>>;
}

/**
 * Docker Container resource
 */
export interface Container
  extends Resource<"docker::api::Container">,
    Dockerode.ImageInspectInfo {}

/**
 * Create and manage a Docker Image
 */
export const Container = Resource(
  "docker::api::Container",
  {
    alwaysUpdate: true,
  },
  async function (
    this: Context<Container, ContainerProps>,
    _id: string,
    props: ContainerProps,
  ): Promise<Container> {
    // Initialize Docker API client
    const dockerHost = await DockerHost<Record<string, DockerRegistry>>(
      props.dockerHost,
    );
    const { dockerode: api } = dockerHost;

    throw new Error(`Container ${_id} not found`);
  },
);
