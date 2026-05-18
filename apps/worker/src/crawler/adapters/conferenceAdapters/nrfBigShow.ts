import { makeConferenceAdapter } from "./_conferenceShared";

export const nrfBigShow = makeConferenceAdapter({
  id: "conference_nrf_big_show",
  hosts: ["nrfbigshow.nrf.com", "bigshow.nrf.com", "nrf.com"],
  url_patterns: [/\/speakers/i, /\/sessions/i, /\/agenda/i],
  event_name: "NRF Big Show",
});
