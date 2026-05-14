import type { Provider } from "../types";
import { hunter } from "./hunter";
import { apollo } from "./apollo";
import { rocketreach } from "./rocketreach";
import { peopledatalabs } from "./peopledatalabs";
import { proxycurl } from "./proxycurl";
import { crunchbase } from "./crunchbase";
import { sec_edgar } from "./sec_edgar";
import { opencorporates } from "./opencorporates";
import { uk_ch } from "./uk_ch";
import { forbes_signals } from "./forbes_signals";
import { whoisxml } from "./whoisxml";
import { twitter_oss } from "./twitter_oss";

export const ALL_PROVIDERS: Provider[] = [
  apollo, crunchbase, proxycurl, hunter, rocketreach, peopledatalabs,
  sec_edgar, uk_ch, opencorporates, twitter_oss, forbes_signals, whoisxml,
];
