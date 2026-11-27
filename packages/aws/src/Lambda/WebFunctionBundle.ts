/**
 * How a Web Function's code is bundled, shared by the live provider
 * ([WebFunction](./WebFunction.ts)) and the floci dev provider's watch loop
 * ([FlociWebFunctionProvider](./FlociWebFunctionProvider.ts)), so both build
 * the same artifact.
 */

import type { FunctionZipProps } from "./Function.ts";
import type { FunctionBundleOptions } from "./FunctionBundle.ts";
import type { WebFunctionProps } from "./WebFunction.ts";

/** Generated entry for Effect web functions. */
const effectEntry = (importPath: string) => `
import { bootstrap } from "@alchemy.run/aws/Bootstrap/LambdaWeb";
import entrypoint from ${JSON.stringify(importPath)};

bootstrap(entrypoint);
`;

/** Only the Effect form gets a generated entry; async servers ship as-is. */
export const webFunctionBundleOptions: FunctionBundleOptions = { entry: effectEntry };

/** The bundler reads the Event Function zip props; Web Functions run on Arm64. */
export const toWebFunctionZipProps = (props: WebFunctionProps): FunctionZipProps =>
  ({ ...props, architecture: "arm64" }) as FunctionZipProps;
