import { makeConferenceAdapter } from "./_conferenceShared";

export const ycCompanyDirectory = makeConferenceAdapter({
  id: "conference_yc",
  hosts: ["ycombinator.com", "www.ycombinator.com"],
  url_patterns: [/^\/companies\//i, /^\/topics\//i],
  event_name: "Y Combinator",
});
