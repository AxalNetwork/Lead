// Conference adapter pack — one file per event, all aggregated here.
// Each file re-exports a SiteAdapter built from the shared factory.

import { ted } from "./ted";
import { ycCompanyDirectory } from "./ycombinator";
import { saastr } from "./saastr";
import { awsReInvent } from "./awsReInvent";
import { consensusInvest } from "./consensusInvest";
import { slush } from "./slush";
import { webSummit } from "./webSummit";
import { nrfBigShow } from "./nrfBigShow";
import { jpmHealthcare } from "./jpmHealthcare";

export {
  ted, ycCompanyDirectory, saastr, awsReInvent, consensusInvest,
  slush, webSummit, nrfBigShow, jpmHealthcare,
};

export const CONFERENCE_ADAPTERS = [
  ted, ycCompanyDirectory, saastr, awsReInvent, consensusInvest,
  slush, webSummit, nrfBigShow, jpmHealthcare,
];
