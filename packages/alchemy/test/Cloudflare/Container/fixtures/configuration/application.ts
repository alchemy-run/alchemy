import * as Cloudflare from "@/Cloudflare";
import type { RemoteContainerProps } from "@/Cloudflare/Containers/ContainerApplication.ts";

export const application = (props: Omit<RemoteContainerProps, "image"> = {}) =>
  Cloudflare.Container("Configuration", {
    image: "mendhak/http-https-echo:41",
    ...props,
  }).Application;

export const externalApplication = () =>
  Cloudflare.Container("DockerfileConfiguration", {
    context: `${import.meta.dirname}/../external/context`,
    dockerfile: "Dockerfile",
    maxInstances: 1,
  }).Application;
