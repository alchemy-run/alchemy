import type {
  DurableFunctionProps,
  FunctionProps,
} from "@/AWS/Lambda/index.ts";

type Assert<T extends true> = T;

export type _ZipFunctionAccepted = Assert<
  { main: "./handler.ts" } extends FunctionProps ? true : false
>;

export type _ImageFunctionAccepted = Assert<
  { image: { context: "./lambda" } } extends FunctionProps ? true : false
>;

export type _MixedPackageRejected = Assert<
  {
    main: "./handler.ts";
    image: { context: "./lambda" };
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageRuntimeOptionsRejected = Assert<
  {
    image: { context: "./lambda" };
    runtime: "nodejs22.x";
  } extends FunctionProps
    ? false
    : true
>;

export type _PackageTypeIsDerived = Assert<
  "packageType" extends keyof FunctionProps ? false : true
>;

export type _DurableFunctionIsZipOnly = Assert<
  { image: { context: "./lambda" } } extends DurableFunctionProps ? false : true
>;
