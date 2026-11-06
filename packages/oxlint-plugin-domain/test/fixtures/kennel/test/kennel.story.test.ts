import { Story } from "@alchemy.run/domain/Story";
import { FeedDog, NotHungry } from "../src/dog/dog.messages.ts";

export const fed = Story.when("dog-1", new FeedDog({}));
export const full = Story.rejected(new NotHungry());
