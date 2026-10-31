import * as Domain from "@alchemy.run/domain";
import { DogId } from "./dog.id.ts";
import { DogFed, FeedDog } from "./dog.messages.ts";

export class Dog extends Domain.Aggregate("Dog", {
  id: DogId,
  commands: [FeedDog],
  decide: { FeedDog: () => [new DogFed()] },
  evolve: { DogFed: (s) => s },
}) {}
