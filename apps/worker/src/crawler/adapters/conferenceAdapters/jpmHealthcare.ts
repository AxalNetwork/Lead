import { makeConferenceAdapter } from "./_conferenceShared";

export const jpmHealthcare = makeConferenceAdapter({
  id: "conference_jpm_healthcare",
  hosts: ["www.jpmorgan.com", "jpmorgan.com"],
  url_patterns: [/healthcare-conference/i, /\/healthcare\/conference/i],
  event_name: "JP Morgan Healthcare Conference",
});
