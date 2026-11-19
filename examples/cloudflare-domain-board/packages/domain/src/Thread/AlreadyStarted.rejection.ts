import * as Domain from "@alchemy.run/domain";
import { ChannelId } from "../Channel/Channel.id.ts";

/** A thread with this id already exists. */
export class AlreadyStarted extends Domain.Rejection(
  "AlreadyStarted",
  { channel: ChannelId },
  { httpApiStatus: 409, description: "A thread with this id already exists." },
) {}
