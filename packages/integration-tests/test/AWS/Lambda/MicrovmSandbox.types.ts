import * as AI from "@alchemy.run/ai";
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large" }>()("Sandbox") {}

const program = Effect.succeed({});

// Every declared size maps to a MicroVM memory.
AWS.Lambda.MicrovmSandbox(
  Sandbox,
  { main: import.meta.url, sizes: { small: "1 GB", large: "8 GB" } },
  program,
);

AWS.Lambda.MicrovmSandbox(
  Sandbox,
  // @ts-expect-error Property 'large' is missing
  { main: import.meta.url, sizes: { small: "1 GB" } },
  program,
);

AWS.Lambda.MicrovmSandbox(
  Sandbox,
  // @ts-expect-error 'huge' is not a declared size
  { main: import.meta.url, sizes: { small: "1 GB", large: "8 GB", huge: "8 GB" } },
  program,
);

AWS.Lambda.MicrovmSandbox(
  Sandbox,
  // @ts-expect-error a size is a memory in GB
  { main: import.meta.url, sizes: { small: "1 GB", large: "standard-4" } },
  program,
);
