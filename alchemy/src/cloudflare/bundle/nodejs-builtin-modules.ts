import { builtinModules } from "node:module";

export const NODEJS_MODULES_RE = new RegExp(
  `^(node:)?(${builtinModules
    .filter(
      (m) =>
        ![
          // in some runtimes (like bun), `ws` is a built-in module but is not in `node`
          // bundling for `nodejs_compat` should not polyfill these modules
          "ws",
        ].includes(m),
    )
    .join("|")})$`,
);
