import { makeConferenceAdapter } from "./_conferenceShared";

export const consensusInvest = makeConferenceAdapter({
  id: "conference_consensus_invest",
  hosts: ["consensus.coindesk.com", "consensusinvest.com"],
  url_patterns: [/\/agenda/i, /\/speakers/i, /\/conferences/i],
  event_name: "Consensus / Consensus Invest",
});
