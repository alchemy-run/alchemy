import {
  Server,
  ServerProvider,
  type ServerDevProps,
  type ServerProps,
} from "alchemy/Website";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const props: ServerProps = {
  framework: "@example/framework",
  target: "@example/framework/target",
  root: ".",
  dev: {
    mode: "external",
    url: "http://localhost:3000",
  },
};

export const devProps: ServerDevProps = {
  mode: "server",
  host: "127.0.0.1",
  port: 3000,
  strictPort: true,
};

// A consuming project can compose the public provider with its own layers.
export const providers = Layer.mergeAll(ServerProvider(), Layer.empty);

const server = Server("PublicWebsite", {
  ...props,
});

export const outputs = Effect.map(server, (resource) => ({
  distDir: resource.distDir,
  clientDir: resource.clientDir,
  serverEntry: resource.serverEntry,
  url: resource.url,
  inputHash: resource.hash.input,
  outputHash: resource.hash.output,
}));
