import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { cleanOutgoingMessage } from "./plainPunctuation.js";

export default definePluginEntry({
  id: "plain-punctuation",
  name: "Plain punctuation",
  description: "Turns long dashes and semicolons in outgoing messages into commas, so texts read human.",
  register(api) {
    api.on("message_sending", cleanOutgoingMessage);
  },
});
