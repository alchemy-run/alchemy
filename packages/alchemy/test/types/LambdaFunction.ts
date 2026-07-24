import type {
  DurableFunctionProps,
  FunctionProps,
} from "@/AWS/Lambda/index.ts";

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
