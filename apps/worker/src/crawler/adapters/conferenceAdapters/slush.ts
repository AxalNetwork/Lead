import { makeConferenceAdapter } from "./_conferenceShared";

export const slush = makeConferenceAdapter({
  id: "conference_slush",
  hosts: ["www.slush.org", "slush.org"],
  url_patterns: [/\/speakers/i, /\/agenda/i, /\/program/i],
  event_name: "Slush",
});
