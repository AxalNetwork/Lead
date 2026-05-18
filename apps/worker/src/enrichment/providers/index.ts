// Task #5: every paid 3rd-party provider has been stub-deprecated; the
// only providers that remain in ALL_PROVIDERS are the in-house / free
// public-data sources. The deprecated provider files (apollo, hunter,
// rocketreach, peopledatalabs, proxycurl, crunchbase, opencorporates,
// uk_ch, whoisxml, forbes_signals) still exist as Provider-shaped
// noops returning `missing_key` so accidental imports don't break
// the typechecker — they are intentionally absent from ALL_PROVIDERS.
import type { Provider } from "../types";
import { sec_edgar } from "./sec_edgar";
import { twitter_oss } from "./twitter_oss";

export const ALL_PROVIDERS: Provider[] = [
  sec_edgar, twitter_oss,
];
