import { makeConferenceAdapter } from "./_conferenceShared";

export const webSummit = makeConferenceAdapter({
  id: "conference_web_summit",
  hosts: ["websummit.com", "www.websummit.com"],
  url_patterns: [/\/speakers/i, /\/agenda/i, /\/conference/i],
  event_name: "Web Summit",
});
