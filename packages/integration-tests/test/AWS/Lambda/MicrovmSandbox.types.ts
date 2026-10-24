import * as AWS from "@alchemy.run/aws";
import * as Sandbox from "@alchemy.run/sandbox";
import * as Effect from "effect/Effect";

class Box extends Sandbox.Sandbox<Box, { size: "small" | "large" }>()("Sandbox") {}

const program = Effect.succeed({});

// Every declared size maps to a MicroVM memory.
AWS.Lambda.MicrovmSandbox(
  Box,
  { main: import.meta.url, sizes: { small: "1 GB", large: "8 GB" } },
  program,
);

AWS.Lambda.MicrovmSandbox(
  Box,
  // @ts-expect-error Property 'large' is missing
  { main: import.meta.url, sizes: { small: "1 GB" } },
  program,
);

AWS.Lambda.MicrovmSandbox(
  Box,
  // @ts-expect-error 'huge' is not a declared size
  { main: import.meta.url, sizes: { small: "1 GB", large: "8 GB", huge: "8 GB" } },
  program,
);

AWS.Lambda.MicrovmSandbox(
  Box,
  // @ts-expect-error a size is a memory in GB
  { main: import.meta.url, sizes: { small: "1 GB", large: "standard-4" } },
  program,
);
