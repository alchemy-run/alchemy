/** RivetKit's async form, as its docs write it: deployed unchanged as an external Durable Object. */
import { actor, setup } from "rivetkit";

export const counter = actor({
  state: { count: 0 },
  actions: {
    increment: (c, x: number) => {
      c.state.count += x;
      return c.state.count;
    },
  },
});

export const registry = setup({
  use: { counter },
});

registry.start();
