import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import { Stack } from "alchemy/Stack";
import StreamingFunction from "./StreamingFunction.ts";

export default class StreamingStack extends Stack {
  constructor() {
    super("streaming-lambda", "dev");
  }

  async run(run: Alchemy.Run) {
    const func = yield* StreamingFunction;

    yield* Alchemy.output("functionUrl", func.functionUrl);
  }
}
