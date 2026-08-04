import type {
  DurableFunctionProps,
  FunctionImageProps,
  FunctionProps,
} from "@/AWS/Lambda/index.ts";
import { Function as LambdaFunction } from "@/AWS/Lambda/index.ts";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;

export type _ZipFunctionAccepted = Assert<
  { main: "./handler.ts" } extends FunctionProps ? true : false
>;

export type _ImageFunctionAccepted = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
  } extends FunctionProps
    ? true
    : false
>;

export type _EcrImageFunctionAccepted = Assert<
  {
    image: {
      uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest";
    };
    architecture: "x86_64";
    imageConfig: {
      command: ["index.handler"];
      entryPoint: ["/lambda-entrypoint.sh"];
      workingDirectory: "/var/task";
    };
  } extends FunctionProps
    ? true
    : false
>;

export type _MixedImageSourcesRejected = Assert<
  {
    image: {
      uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest";
      context: "./lambda";
      dockerfile: "Dockerfile";
    };
    architecture: "x86_64";
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageDockerfileRequired = Assert<
  {
    image: { context: "./lambda" };
    architecture: "x86_64";
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageArchitectureRequired = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
  } extends FunctionProps
    ? false
    : true
>;

export type _MixedPackageRejected = Assert<
  {
    main: "./handler.ts";
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageRuntimeOptionsRejected = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
    runtime: "nodejs22.x";
  } extends FunctionProps
    ? false
    : true
>;

export type _ZipImageConfigRejected = Assert<
  {
    main: "./handler.ts";
    imageConfig: { command: ["index.handler"] };
  } extends FunctionProps
    ? false
    : true
>;

export type _PackageTypeIsDerived = Assert<
  "packageType" extends keyof FunctionProps ? false : true
>;

export type _DurableFunctionIsZipOnly = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
  } extends DurableFunctionProps
    ? false
    : true
>;

LambdaFunction("zip-inline-accepted", { main: "./handler.ts" }, Effect.void);

const imageProps: FunctionImageProps = {
  image: { context: "./lambda", dockerfile: "Dockerfile" },
  architecture: "x86_64",
};

// @ts-expect-error Image functions use the Dockerfile's handler.
LambdaFunction("image-inline-rejected", imageProps, Effect.void);
