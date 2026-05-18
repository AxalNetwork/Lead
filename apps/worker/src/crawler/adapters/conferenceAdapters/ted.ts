import { makeConferenceAdapter } from "./_conferenceShared";

export const ted = makeConferenceAdapter({
  id: "conference_ted",
  hosts: ["ted.com", "www.ted.com"],
  url_patterns: [/^\/speakers/i, /^\/talks/i, /^\/conferences/i],
  event_name: "TED",
});
