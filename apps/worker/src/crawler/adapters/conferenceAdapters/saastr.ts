import { makeConferenceAdapter } from "./_conferenceShared";

export const saastr = makeConferenceAdapter({
  id: "conference_saastr",
  hosts: ["www.saastr.com", "saastr.com", "annual2024.saastr.com", "annual2025.saastr.com"],
  url_patterns: [/\/speaker/i, /\/agenda/i, /\/events?\//i],
  event_name: "SaaStr",
});
