import { makeConferenceAdapter } from "./_conferenceShared";

export const awsReInvent = makeConferenceAdapter({
  id: "conference_aws_reinvent",
  hosts: ["reinvent.awsevents.com", "aws.amazon.com"],
  url_patterns: [/\/reinvent/i, /\/agenda/i, /\/speakers/i],
  event_name: "AWS re:Invent",
});
