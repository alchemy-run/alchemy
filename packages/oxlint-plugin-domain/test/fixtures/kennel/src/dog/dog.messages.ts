import * as Domain from "@alchemy.run/domain";
import { DogId } from "./dog.id.ts";

export class NotHungry extends Domain.Rejection("NotHungry") {}
export class Asleep extends Domain.Rejection("Asleep") {}

export class DogFed extends Domain.Event("DogFed", {}) {}
export class DogWalked extends Domain.Event("DogWalked", {}) {}

export class FeedDog extends Domain.Command("FeedDog", {
  target: DogId,
  events: [DogFed],
  rejects: [NotHungry],
}) {}

export class WalkDog extends Domain.Command("WalkDog", {
  target: DogId,
  events: [DogWalked],
  rejects: [],
}) {}
