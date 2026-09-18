import type { ImageOptions } from "@/Docker";
import type { ContainerApplicationProps } from "@/Cloudflare/Containers/ContainerApplication";
import type { Input } from "@/Input";
import type { Output } from "@/Output";

type Assert<T extends true> = T;

export type _Build = Assert<
  { context: "./web"; publish: { repository: "web" } } extends ImageOptions
    ? true
    : false
>;
export type _Inline = Assert<
  {
    dockerfile: { content: "FROM alpine" };
    files: [{ path: "payload"; content: "hello"; mode: 493 }];
  } extends ImageOptions
    ? true
    : false
>;
export type _Reference = Assert<
  { ref: "nginx:alpine" } extends ImageOptions ? true : false
>;
export type _OutputReference = Assert<
  { ref: Output<string> } extends Input<ImageOptions> ? true : false
>;
export type _MixedSourceRejected = Assert<
  { ref: "nginx:alpine"; context: "./web" } extends ImageOptions ? false : true
>;
export type _RemoteBuildArgumentsRejected = Assert<
  { ref: "nginx:alpine"; args: { VERSION: "1" } } extends ImageOptions
    ? false
    : true
>;
export type _EmptyRejected = Assert<{} extends ImageOptions ? false : true>;
export type _ContainerBuild = Assert<
  { image: { context: "./web" } } extends ContainerApplicationProps
    ? true
    : false
>;
export type _ContainerReference = Assert<
  { image: { ref: "nginx:alpine" } } extends ContainerApplicationProps
    ? true
    : false
>;
export type _ContainerMixedSourceRejected = Assert<
  {
    maxInstances: 2;
    image: { ref: "nginx:alpine"; context: "./web" };
  } extends ContainerApplicationProps
    ? false
    : true
>;
export type _ContainerMainAndImageRejected = Assert<
  {
    main: "./main.ts";
    image: { context: "./web" };
  } extends ContainerApplicationProps
    ? false
    : true
>;
export type _ContainerTopLevelContextRejected = Assert<
  {
    context: "./web";
    image: { ref: "nginx:alpine" };
  } extends ContainerApplicationProps
    ? false
    : true
>;
