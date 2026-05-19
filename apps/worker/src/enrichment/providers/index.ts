// Task #5: every paid 3rd-party provider has been removed. The only
// providers that remain are the in-house / free public-data sources
// (sec_edgar, twitter_oss). The deprecated provider files (apollo,
// hunter, rocketreach, peopledatalabs, proxycurl, crunchbase,
// opencorporates, uk_ch, whoisxml, forbes_signals) have been deleted
// outright — any future re-introduction must go through the in-house
// crawler + SiteAdapter + R2 archive path.
import type { Provider } from "../types";
import { sec_edgar } from "./sec_edgar";
import { twitter_oss } from "./twitter_oss";

export const ALL_PROVIDERS: Provider[] = [
  sec_edgar, twitter_oss,
];
