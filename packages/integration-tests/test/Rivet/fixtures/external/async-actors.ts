/** RivetKit's async form, as its docs write it: deployed unchanged as an external Durable Object. */
import { actor, setup } from "rivetkit";

export const counter = actor({
  state: { count: 0 },
  actions: {
    increment: (c, x: number) => {
      // The prebuilt image's `STEP`; 1 when bundled.
      c.state.count += x * Number(process.env.STEP ?? 1);
      return c.state.count;
    },
  },
});

export const registry = setup({
  use: { counter },
});

registry.start();
