import { Resource } from "./resource";

export class Print extends Resource(
  "Print",
  {
    alwaysUpdate: true,
  },
  async (
    ctx,
    values: {
      [key: string]: any;
    },
  ) => {
    if (ctx.event !== "delete") {
      console.log(JSON.stringify(values, null, 2));
    }
  },
) {}
