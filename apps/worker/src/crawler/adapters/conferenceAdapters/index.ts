// Conference speaker / agenda adapter pack. One thin adapter per major
// event. Each emits `conference_organizer` + speaker candidate names
// pulled from the agenda HTML. Generic conference HTML extraction lives
// in `_conferenceShared.ts` so each adapter only declares hosts and
// type tags.

import { makeConferenceAdapter } from "./_conferenceShared";

export const ted = makeConferenceAdapter({
  id: "conference_ted",
  hosts: ["ted.com", "www.ted.com"],
  url_patterns: [/^\/speakers/i, /^\/talks/i, /^\/conferences/i],
  event_name: "TED",
});

export const ycCompanyDirectory = makeConferenceAdapter({
  id: "conference_yc",
  hosts: ["ycombinator.com", "www.ycombinator.com"],
  url_patterns: [/^\/companies\//i, /^\/topics\//i],
  event_name: "Y Combinator",
});

export const saastr = makeConferenceAdapter({
  id: "conference_saastr",
  hosts: ["www.saastr.com", "saastr.com", "annual2024.saastr.com", "annual2025.saastr.com"],
  url_patterns: [/\/speaker/i, /\/agenda/i, /\/events?\//i],
  event_name: "SaaStr",
});

export const awsReInvent = makeConferenceAdapter({
  id: "conference_aws_reinvent",
  hosts: ["reinvent.awsevents.com", "aws.amazon.com"],
  url_patterns: [/\/reinvent/i, /\/agenda/i, /\/speakers/i],
  event_name: "AWS re:Invent",
});

export const consensusInvest = makeConferenceAdapter({
  id: "conference_consensus_invest",
  hosts: ["consensus.coindesk.com", "consensusinvest.com"],
  url_patterns: [/\/agenda/i, /\/speakers/i, /\/conferences/i],
  event_name: "Consensus / Consensus Invest",
});

export const slush = makeConferenceAdapter({
  id: "conference_slush",
  hosts: ["www.slush.org", "slush.org"],
  url_patterns: [/\/speakers/i, /\/agenda/i, /\/program/i],
  event_name: "Slush",
});

export const webSummit = makeConferenceAdapter({
  id: "conference_web_summit",
  hosts: ["websummit.com", "www.websummit.com"],
  url_patterns: [/\/speakers/i, /\/agenda/i, /\/conference/i],
  event_name: "Web Summit",
});

export const nrfBigShow = makeConferenceAdapter({
  id: "conference_nrf_big_show",
  hosts: ["nrfbigshow.nrf.com", "bigshow.nrf.com", "nrf.com"],
  url_patterns: [/\/speakers/i, /\/sessions/i, /\/agenda/i],
  event_name: "NRF Big Show",
});

export const jpmHealthcare = makeConferenceAdapter({
  id: "conference_jpm_healthcare",
  hosts: ["www.jpmorgan.com", "jpmorgan.com"],
  url_patterns: [/healthcare-conference/i, /\/healthcare\/conference/i],
  event_name: "JP Morgan Healthcare Conference",
});

export const CONFERENCE_ADAPTERS = [
  ted, ycCompanyDirectory, saastr, awsReInvent, consensusInvest,
  slush, webSummit, nrfBigShow, jpmHealthcare,
];
