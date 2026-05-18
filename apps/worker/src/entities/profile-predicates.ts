// Task #4: Predicate registry — single source of truth.
//
// The same list is mirrored into `predicate_registry` by migration 328.
// Every predicate string that `profile.ts` ever passes to `insertFact`
// MUST appear in this array; the CI smoke test (test/profile.test.mjs)
// enforces it. Adding a new predicate is a TWO-file change:
//   1. append it here AND
//   2. add the matching `INSERT OR IGNORE INTO predicate_registry` row in
//      migration 328_predicate_registry.sql.
//
// `value_type` is informational metadata for the UI formatter — it does
// not constrain the runtime shape of the fact value_json (those shapes
// live in profile-shapes.ts).

export type PredicateValueType =
  | "text" | "number" | "boolean" | "date" | "year" | "url" | "email"
  | "json" | "entity_ref" | "currency_usd" | "country_iso2" | "language";

export interface PredicateMeta {
  predicate: string;
  label: string;
  icon: string;       // lucide icon slug — UI renders <i data-lucide="…" />
  formatter: string;  // ui formatter id — 'text'|'date'|'year'|'usd'|'list'|'badge'|'link'|'flag'|'avatar'
  category: string;   // ui tab — 'identity'|'career'|'education'|'family'|'preference'|'interest'|'lifestyle'|'travel'|'conference'|'goal'|'hook'|'appreciation'|'contact'|'firm'|'misc'
  value_type: PredicateValueType;
  description: string;
}

export const PREDICATE_REGISTRY: PredicateMeta[] = [
  // ---- identity (rich-profile) -------------------------------------------
  { predicate: "person.identity",              label: "Identity snapshot",     icon: "user",        formatter: "json",  category: "identity",    value_type: "json",         description: "Snapshot of person_identity row." },
  { predicate: "person.identity.full_name",    label: "Full name",             icon: "user",        formatter: "text",  category: "identity",    value_type: "text",         description: "Legal or commonly used full name." },
  { predicate: "person.identity.preferred_name", label: "Preferred name",      icon: "user",        formatter: "text",  category: "identity",    value_type: "text",         description: "What the person prefers to be called." },
  { predicate: "person.identity.pronouns",     label: "Pronouns",              icon: "user-circle", formatter: "text",  category: "identity",    value_type: "json",         description: "Pronouns triple (subject/object/possessive)." },
  { predicate: "person.identity.birth_year",   label: "Birth year",            icon: "cake",        formatter: "year",  category: "identity",    value_type: "year",         description: "Year of birth (no full DOB stored)." },
  { predicate: "person.identity.nationality",  label: "Nationality",           icon: "flag",        formatter: "flag",  category: "identity",    value_type: "country_iso2", description: "ISO-3166-1 alpha-2 nationality." },
  { predicate: "person.identity.languages",    label: "Languages",             icon: "languages",   formatter: "list",  category: "identity",    value_type: "json",         description: "Spoken languages with proficiency." },
  { predicate: "person.identity.timezone",     label: "Timezone",              icon: "clock",       formatter: "text",  category: "identity",    value_type: "text",         description: "IANA tz database name." },
  { predicate: "person.identity.location_city",    label: "City",              icon: "map-pin",     formatter: "text",  category: "identity",    value_type: "text",         description: "Current city of residence." },
  { predicate: "person.identity.location_country", label: "Country",           icon: "globe",       formatter: "flag",  category: "identity",    value_type: "country_iso2", description: "Current country of residence." },
  { predicate: "person.identity.headshot_url", label: "Headshot",              icon: "image",       formatter: "avatar",category: "identity",    value_type: "url",          description: "Public headshot image URL." },

  // ---- career -------------------------------------------------------------
  { predicate: "person.career",                label: "Career entry",          icon: "briefcase",   formatter: "json",  category: "career",      value_type: "json",         description: "Snapshot of a career_history row." },

  // ---- board --------------------------------------------------------------
  { predicate: "person.board_seat",            label: "Board seat",            icon: "users",       formatter: "json",  category: "career",      value_type: "json",         description: "Snapshot of a board_seats row." },

  // ---- education ----------------------------------------------------------
  { predicate: "person.education",             label: "Education",             icon: "graduation-cap", formatter: "json", category: "education",  value_type: "json",        description: "Snapshot of an education_history row." },

  // ---- family -------------------------------------------------------------
  { predicate: "person.family_tie",            label: "Family tie",            icon: "heart",       formatter: "json",  category: "family",      value_type: "json",         description: "Snapshot of a family_ties row." },

  // ---- conference ---------------------------------------------------------
  { predicate: "person.conference",            label: "Conference",            icon: "calendar",    formatter: "json",  category: "conference",  value_type: "json",         description: "Snapshot of a conference_attendance row." },

  // ---- preferences (one predicate per documented preference_key) ---------
  { predicate: "person.preference.communication_channel", label: "Communication channel", icon: "message-circle", formatter: "text",  category: "preference", value_type: "text", description: "Preferred contact channel (email/text/dm/voice)." },
  { predicate: "person.preference.contact_time",          label: "Best time to reach",    icon: "clock",          formatter: "text",  category: "preference", value_type: "text", description: "Preferred contact window or day." },
  { predicate: "person.preference.meeting_format",        label: "Meeting format",        icon: "video",          formatter: "text",  category: "preference", value_type: "text", description: "In-person, video, phone, async." },
  { predicate: "person.preference.gift_dietary",          label: "Dietary",               icon: "salad",          formatter: "text",  category: "preference", value_type: "text", description: "Vegan/vegetarian/keto/halal/etc." },
  { predicate: "person.preference.gift_allergies",        label: "Allergies",             icon: "alert-triangle", formatter: "list",  category: "preference", value_type: "json", description: "Food/material allergies to avoid for gifting." },
  { predicate: "person.preference.coffee_order",          label: "Coffee order",          icon: "coffee",         formatter: "text",  category: "preference", value_type: "text", description: "Usual coffee order." },
  { predicate: "person.preference.travel_class",          label: "Travel class",          icon: "plane",          formatter: "text",  category: "preference", value_type: "text", description: "Preferred flight cabin class." },
  { predicate: "person.preference.hotel_brand",           label: "Hotel brand",           icon: "bed",            formatter: "text",  category: "preference", value_type: "text", description: "Preferred hotel chain or brand." },
  { predicate: "person.preference.airline_status",        label: "Airline status",        icon: "plane",          formatter: "text",  category: "preference", value_type: "text", description: "Frequent-flyer status / preferred carrier." },

  // ---- interests (one per category) --------------------------------------
  { predicate: "person.interest.topic",   label: "Topic",     icon: "tag",         formatter: "badge", category: "interest", value_type: "text", description: "Topic of interest." },
  { predicate: "person.interest.sport",   label: "Sport",     icon: "trophy",      formatter: "badge", category: "interest", value_type: "text", description: "Sport played or followed." },
  { predicate: "person.interest.team",    label: "Team",      icon: "shield",      formatter: "badge", category: "interest", value_type: "text", description: "Favorite team." },
  { predicate: "person.interest.book",    label: "Book",      icon: "book",        formatter: "text",  category: "interest", value_type: "text", description: "Book the person recommends or read." },
  { predicate: "person.interest.author",  label: "Author",    icon: "feather",     formatter: "text",  category: "interest", value_type: "text", description: "Favorite author." },
  { predicate: "person.interest.podcast", label: "Podcast",   icon: "mic",         formatter: "text",  category: "interest", value_type: "text", description: "Podcast the person listens to." },
  { predicate: "person.interest.music",   label: "Music genre", icon: "music",     formatter: "badge", category: "interest", value_type: "text", description: "Preferred music genre." },
  { predicate: "person.interest.artist",  label: "Artist",    icon: "music",       formatter: "text",  category: "interest", value_type: "text", description: "Favorite musical artist." },
  { predicate: "person.interest.film",    label: "Film",      icon: "film",        formatter: "text",  category: "interest", value_type: "text", description: "Favorite film." },
  { predicate: "person.interest.show",    label: "TV show",   icon: "tv",          formatter: "text",  category: "interest", value_type: "text", description: "Favorite TV show." },
  { predicate: "person.interest.hobby",   label: "Hobby",     icon: "puzzle",      formatter: "badge", category: "interest", value_type: "text", description: "Hobby outside of work." },
  { predicate: "person.interest.cause",   label: "Cause",     icon: "heart-handshake", formatter: "badge", category: "interest", value_type: "text", description: "Cause the person supports." },

  // ---- lifestyle signals -------------------------------------------------
  { predicate: "person.lifestyle.runs",      label: "Runs",        icon: "footprints", formatter: "text", category: "lifestyle", value_type: "json", description: "Is a runner." },
  { predicate: "person.lifestyle.cycles",    label: "Cycles",      icon: "bike",       formatter: "text", category: "lifestyle", value_type: "json", description: "Cycles." },
  { predicate: "person.lifestyle.surfs",     label: "Surfs",       icon: "waves",      formatter: "text", category: "lifestyle", value_type: "json", description: "Surfs." },
  { predicate: "person.lifestyle.skis",      label: "Skis",        icon: "snowflake",  formatter: "text", category: "lifestyle", value_type: "json", description: "Skis or snowboards." },
  { predicate: "person.lifestyle.golfs",     label: "Golfs",       icon: "flag",       formatter: "text", category: "lifestyle", value_type: "json", description: "Plays golf." },
  { predicate: "person.lifestyle.yoga",      label: "Yoga",        icon: "activity",   formatter: "text", category: "lifestyle", value_type: "json", description: "Practices yoga." },
  { predicate: "person.lifestyle.meditates", label: "Meditates",   icon: "leaf",       formatter: "text", category: "lifestyle", value_type: "json", description: "Meditates regularly." },
  { predicate: "person.lifestyle.cooks",     label: "Cooks",       icon: "chef-hat",   formatter: "text", category: "lifestyle", value_type: "json", description: "Cooks for fun." },
  { predicate: "person.lifestyle.collects",  label: "Collects",    icon: "package",    formatter: "text", category: "lifestyle", value_type: "json", description: "Collects something (art, wine, watches…)." },
  { predicate: "person.lifestyle.pet",       label: "Pet",         icon: "paw-print",  formatter: "text", category: "lifestyle", value_type: "json", description: "Has a pet." },
  { predicate: "person.lifestyle.marathon",  label: "Marathon",    icon: "medal",      formatter: "text", category: "lifestyle", value_type: "json", description: "Completed marathon." },
  { predicate: "person.lifestyle.ironman",   label: "Ironman",     icon: "medal",      formatter: "text", category: "lifestyle", value_type: "json", description: "Completed Ironman triathlon." },

  // ---- travel -------------------------------------------------------------
  { predicate: "person.travel.frequent_city",  label: "Frequent city",  icon: "map-pin", formatter: "text", category: "travel", value_type: "text", description: "City the person frequently travels to." },
  { predicate: "person.travel.home_base",      label: "Home base",      icon: "home",    formatter: "text", category: "travel", value_type: "text", description: "Stated home base." },
  { predicate: "person.travel.recent_trip",    label: "Recent trip",    icon: "plane",   formatter: "text", category: "travel", value_type: "text", description: "Recent trip place + date window." },
  { predicate: "person.travel.upcoming_trip",  label: "Upcoming trip",  icon: "plane",   formatter: "text", category: "travel", value_type: "text", description: "Announced upcoming trip." },
  { predicate: "person.travel.airport_hub",    label: "Airport hub",    icon: "plane",   formatter: "text", category: "travel", value_type: "text", description: "Home airport (IATA code)." },

  // ---- goals --------------------------------------------------------------
  { predicate: "person.goal.short_term",        label: "Short-term goal",     icon: "target",        formatter: "text", category: "goal", value_type: "text", description: "Goal stated for <12 months." },
  { predicate: "person.goal.long_term",         label: "Long-term goal",      icon: "target",        formatter: "text", category: "goal", value_type: "text", description: "Goal stated for 12+ months." },
  { predicate: "person.goal.hiring",            label: "Hiring goal",         icon: "user-plus",     formatter: "text", category: "goal", value_type: "text", description: "Stated hiring need." },
  { predicate: "person.goal.fundraising",       label: "Fundraising goal",    icon: "dollar-sign",   formatter: "text", category: "goal", value_type: "text", description: "Stated fundraising plan." },
  { predicate: "person.goal.investing_thesis",  label: "Investing thesis",    icon: "lightbulb",     formatter: "text", category: "goal", value_type: "text", description: "Stated investing thesis." },
  { predicate: "person.goal.expansion_market",  label: "Expansion market",    icon: "map",           formatter: "text", category: "goal", value_type: "text", description: "Stated market expansion." },

  // ---- conversation hooks ------------------------------------------------
  { predicate: "person.hook.recent_news",        label: "Recent news",         icon: "newspaper",      formatter: "text", category: "hook", value_type: "text", description: "Recent news about the person." },
  { predicate: "person.hook.shared_connection",  label: "Shared connection",   icon: "users",          formatter: "text", category: "hook", value_type: "text", description: "Mutual contact you can mention." },
  { predicate: "person.hook.shared_school",      label: "Shared school",       icon: "graduation-cap", formatter: "text", category: "hook", value_type: "text", description: "Shared alma mater." },
  { predicate: "person.hook.shared_employer",    label: "Shared employer",     icon: "briefcase",      formatter: "text", category: "hook", value_type: "text", description: "Shared former or current employer." },
  { predicate: "person.hook.shared_interest",    label: "Shared interest",     icon: "tag",            formatter: "text", category: "hook", value_type: "text", description: "Shared interest or hobby." },
  { predicate: "person.hook.recent_post",        label: "Recent post",         icon: "message-square", formatter: "text", category: "hook", value_type: "text", description: "Recent public post by the person." },
  { predicate: "person.hook.life_event",         label: "Life event",          icon: "sparkles",       formatter: "text", category: "hook", value_type: "text", description: "Life event (job change, baby, move)." },
  { predicate: "person.hook.opinion_quoted",     label: "Opinion quoted",      icon: "quote",          formatter: "text", category: "hook", value_type: "text", description: "Public statement on a topic." },

  // ---- appreciation ------------------------------------------------------
  { predicate: "person.appreciation.compliment_topic",     label: "Compliment topic",     icon: "thumbs-up", formatter: "text", category: "appreciation", value_type: "text", description: "Topic the person likes to be complimented on." },
  { predicate: "person.appreciation.gift_idea",            label: "Gift idea",            icon: "gift",      formatter: "text", category: "appreciation", value_type: "text", description: "Concrete gift idea." },
  { predicate: "person.appreciation.charity_supported",    label: "Charity supported",    icon: "heart",     formatter: "text", category: "appreciation", value_type: "text", description: "Charity the person supports." },
  { predicate: "person.appreciation.cause_advocated",      label: "Cause advocated",      icon: "megaphone", formatter: "text", category: "appreciation", value_type: "text", description: "Cause the person publicly advocates." },
  { predicate: "person.appreciation.recognition_received", label: "Recognition received", icon: "award",     formatter: "text", category: "appreciation", value_type: "text", description: "Public award/recognition received." },

  // ---- legacy / extractor predicates (so the UI never renders a raw key) -
  { predicate: "name",                 label: "Name",              icon: "user",        formatter: "text",  category: "identity", value_type: "text",         description: "Display name (extractor field)." },
  { predicate: "title",                label: "Title",             icon: "briefcase",   formatter: "text",  category: "career",   value_type: "text",         description: "Job title (extractor field)." },
  { predicate: "role",                 label: "Role",              icon: "briefcase",   formatter: "text",  category: "career",   value_type: "text",         description: "Functional role." },
  { predicate: "employer",             label: "Employer",          icon: "building",    formatter: "text",  category: "career",   value_type: "text",         description: "Current employer name." },
  { predicate: "company",              label: "Company",           icon: "building",    formatter: "text",  category: "career",   value_type: "text",         description: "Alias for employer in some extractors." },
  { predicate: "headline",             label: "Headline",          icon: "type",        formatter: "text",  category: "identity", value_type: "text",         description: "LinkedIn-style headline." },
  { predicate: "summary",              label: "Summary",           icon: "file-text",   formatter: "text",  category: "identity", value_type: "text",         description: "Bio / summary paragraph." },
  { predicate: "bio",                  label: "Bio",               icon: "file-text",   formatter: "text",  category: "identity", value_type: "text",         description: "Profile bio." },
  { predicate: "description",          label: "Description",       icon: "file-text",   formatter: "text",  category: "firm",     value_type: "text",         description: "Org/company description." },
  { predicate: "location",             label: "Location",          icon: "map-pin",     formatter: "text",  category: "identity", value_type: "text",         description: "Stated location string." },
  { predicate: "city",                 label: "City",              icon: "map-pin",     formatter: "text",  category: "identity", value_type: "text",         description: "City (extractor field)." },
  { predicate: "region",               label: "Region",            icon: "map",         formatter: "text",  category: "identity", value_type: "text",         description: "State/region." },
  { predicate: "country",              label: "Country",           icon: "globe",       formatter: "text",  category: "identity", value_type: "text",         description: "Country (name string)." },
  { predicate: "country_iso2",         label: "Country (ISO)",     icon: "flag",        formatter: "flag",  category: "identity", value_type: "country_iso2", description: "ISO 3166-1 alpha-2 country." },
  { predicate: "timezone",             label: "Timezone",          icon: "clock",       formatter: "text",  category: "identity", value_type: "text",         description: "Timezone (extractor field)." },
  { predicate: "email",                label: "Email",             icon: "mail",        formatter: "link",  category: "contact",  value_type: "email",        description: "Email address." },
  { predicate: "phone",                label: "Phone",             icon: "phone",       formatter: "text",  category: "contact",  value_type: "text",         description: "Phone number (E.164 preferred)." },
  { predicate: "linkedin_url",         label: "LinkedIn",          icon: "linkedin",    formatter: "link",  category: "contact",  value_type: "url",          description: "LinkedIn profile URL." },
  { predicate: "twitter_url",          label: "Twitter",           icon: "twitter",     formatter: "link",  category: "contact",  value_type: "url",          description: "Twitter/X profile URL." },
  { predicate: "twitter_handle",       label: "Twitter handle",    icon: "twitter",     formatter: "text",  category: "contact",  value_type: "text",         description: "Twitter/X handle." },
  { predicate: "github_url",           label: "GitHub",            icon: "github",      formatter: "link",  category: "contact",  value_type: "url",          description: "GitHub profile URL." },
  { predicate: "github_handle",        label: "GitHub handle",     icon: "github",      formatter: "text",  category: "contact",  value_type: "text",         description: "GitHub handle." },
  { predicate: "website",              label: "Website",           icon: "link",        formatter: "link",  category: "contact",  value_type: "url",          description: "Personal/firm website URL." },
  { predicate: "primary_domain",       label: "Primary domain",    icon: "globe",       formatter: "text",  category: "firm",     value_type: "text",         description: "Canonical apex domain." },
  { predicate: "sector",               label: "Sector",            icon: "layers",      formatter: "badge", category: "firm",     value_type: "text",         description: "Sector / vertical tag." },
  { predicate: "stage",                label: "Stage",             icon: "trending-up", formatter: "badge", category: "firm",     value_type: "text",         description: "Investment stage focus." },
  { predicate: "check_size_min_usd",   label: "Min check (USD)",   icon: "dollar-sign", formatter: "usd",   category: "firm",     value_type: "currency_usd", description: "Minimum typical check size." },
  { predicate: "check_size_max_usd",   label: "Max check (USD)",   icon: "dollar-sign", formatter: "usd",   category: "firm",     value_type: "currency_usd", description: "Maximum typical check size." },
  { predicate: "fund_size_usd",        label: "Fund size (USD)",   icon: "dollar-sign", formatter: "usd",   category: "firm",     value_type: "currency_usd", description: "Most recent fund size." },
  { predicate: "founded_year",         label: "Founded year",      icon: "calendar",    formatter: "year",  category: "firm",     value_type: "year",         description: "Year founded." },
  { predicate: "founded_at",           label: "Founded",           icon: "calendar",    formatter: "date",  category: "firm",     value_type: "date",         description: "Founding date (full)." },
  { predicate: "funding_stage",        label: "Funding stage",     icon: "trending-up", formatter: "badge", category: "firm",     value_type: "text",         description: "Latest funding stage." },
  { predicate: "total_funding_usd",    label: "Total funding (USD)", icon: "dollar-sign", formatter: "usd", category: "firm",     value_type: "currency_usd", description: "Total funding raised." },
  { predicate: "last_round_usd",       label: "Last round (USD)",  icon: "dollar-sign", formatter: "usd",   category: "firm",     value_type: "currency_usd", description: "Most recent round amount." },
  { predicate: "hq_city",              label: "HQ city",           icon: "map-pin",     formatter: "text",  category: "firm",     value_type: "text",         description: "HQ city." },
  { predicate: "hq_country_iso2",      label: "HQ country (ISO)",  icon: "flag",        formatter: "flag",  category: "firm",     value_type: "country_iso2", description: "HQ country ISO code." },
  { predicate: "employees",            label: "Employees",         icon: "users",       formatter: "text",  category: "firm",     value_type: "number",       description: "Employee headcount or band." },
  { predicate: "industry",             label: "Industry",          icon: "layers",      formatter: "badge", category: "firm",     value_type: "text",         description: "Industry classification." },
  { predicate: "display_name",         label: "Display name",      icon: "user",        formatter: "text",  category: "identity", value_type: "text",         description: "Canonical display name." },

  // ---- Task #1: SEC EDGAR deep-adapter predicates -----------------------
  // Mirror in migration 349_sec_edgar.sql — two-file change enforced by
  // test/profile.test.mjs.
  { predicate: "sec.cik",                       label: "SEC CIK",              icon: "hash",         formatter: "text", category: "identity", value_type: "text",         description: "SEC Central Index Key (10-digit, zero-padded)." },
  { predicate: "sec.crd",                       label: "SEC CRD",              icon: "hash",         formatter: "text", category: "identity", value_type: "text",         description: "Investment Adviser CRD# from Form ADV." },
  { predicate: "sec.cusip",                     label: "CUSIP",                icon: "hash",         formatter: "text", category: "identity", value_type: "text",         description: "Committee on Uniform Securities Identification Procedures code." },
  { predicate: "sec.ticker",                    label: "Ticker",               icon: "trending-up",  formatter: "badge",category: "identity", value_type: "text",         description: "Public ticker symbol." },
  { predicate: "sec.sec_file_number",           label: "SEC file number",      icon: "hash",         formatter: "text", category: "identity", value_type: "text",         description: "SEC file number (e.g. 801-12345 for advisers)." },
  { predicate: "sec.fund_id_807",               label: "SEC fund ID",          icon: "hash",         formatter: "text", category: "identity", value_type: "text",         description: "SEC fund identifier (807-XXXXXXXX)." },
  { predicate: "aum_usd",                       label: "AUM (USD)",            icon: "dollar-sign",  formatter: "usd",  category: "firm",     value_type: "currency_usd", description: "Assets under management in USD." },
  { predicate: "sec.form_adv.filed_at",         label: "Last Form ADV filed",  icon: "calendar",     formatter: "date", category: "firm",     value_type: "date",         description: "Most recent Form ADV acceptance date." },
  { predicate: "sec.form_adv.fund",             label: "Form ADV fund",        icon: "briefcase",    formatter: "json", category: "firm",     value_type: "json",         description: "Fund disclosed on Schedule D §7.B.(1)." },
  { predicate: "sec.form_d.round",              label: "Form D round",         icon: "dollar-sign",  formatter: "json", category: "firm",     value_type: "json",         description: "Private placement disclosed on Form D." },
  { predicate: "sec.form_d.issuer_industry",    label: "Form D industry",      icon: "layers",       formatter: "badge",category: "firm",     value_type: "text",         description: "Industry group declared on Form D." },
  { predicate: "sec.13f.holding",               label: "13F holding",          icon: "briefcase",    formatter: "json", category: "firm",     value_type: "json",         description: "Equity position disclosed on Form 13F-HR." },
  { predicate: "sec.13f.filer_aum_usd",         label: "13F filer AUM (USD)",  icon: "dollar-sign",  formatter: "usd",  category: "firm",     value_type: "currency_usd", description: "Aggregate USD value of 13F holdings (proxy AUM)." },
  { predicate: "sec.13d.beneficial_owner",      label: "13D beneficial owner", icon: "users",        formatter: "json", category: "firm",     value_type: "json",         description: "Schedule 13D 5%+ beneficial-ownership disclosure." },
  { predicate: "sec.form4.insider_trade",       label: "Insider trade",        icon: "arrow-up-down",formatter: "json", category: "firm",     value_type: "json",         description: "Form 4 §16 insider transaction." },
  { predicate: "sec.form4.officer_title",       label: "Officer title",        icon: "briefcase",    formatter: "text", category: "career",   value_type: "text",         description: "Officer title declared on Form 4 (when reporter is officer)." },
  { predicate: "sec.s1.ipo_intent",             label: "S-1 IPO intent",       icon: "rocket",       formatter: "text", category: "firm",     value_type: "text",         description: "Company filed Form S-1 (IPO registration)." },
  { predicate: "sec.s1.underwriter",            label: "IPO underwriter",      icon: "briefcase",    formatter: "text", category: "firm",     value_type: "text",         description: "Underwriter listed on Form S-1." },
  { predicate: "sec.8k.material_event",         label: "8-K material event",   icon: "alert-circle", formatter: "json", category: "firm",     value_type: "json",         description: "Form 8-K current report item." },
  { predicate: "sec.10k.revenue_usd",           label: "10-K revenue (USD)",   icon: "dollar-sign",  formatter: "usd",  category: "firm",     value_type: "currency_usd", description: "Annual revenue from Form 10-K." },
  { predicate: "sec.10k.net_income_usd",        label: "10-K net income",      icon: "dollar-sign",  formatter: "usd",  category: "firm",     value_type: "currency_usd", description: "Net income from Form 10-K." },
  { predicate: "sec.10k.fiscal_year_end",       label: "10-K fiscal year-end", icon: "calendar",     formatter: "date", category: "firm",     value_type: "date",         description: "Fiscal year-end from Form 10-K." },
  { predicate: "sec.10k.executive",             label: "10-K executive",       icon: "users",        formatter: "json", category: "firm",     value_type: "json",         description: "Named executive officer compensation from Form 10-K." },
  { predicate: "sec.pf.fund",                   label: "Form PF fund",         icon: "briefcase",    formatter: "json", category: "firm",     value_type: "json",         description: "Private fund disclosure from Form PF (large private fund adviser)." },
  { predicate: "sec.gp_disclosed",              label: "GP disclosed (SEC)",   icon: "user-check",   formatter: "text", category: "firm",     value_type: "text",         description: "GP / control-person disclosed on a SEC filing." },
];

export const PREDICATE_MAP: Record<string, PredicateMeta> = Object.freeze(
  Object.fromEntries(PREDICATE_REGISTRY.map((p) => [p.predicate, p])),
);

export function getPredicateMeta(predicate: string): PredicateMeta | null {
  return PREDICATE_MAP[predicate] ?? null;
}

// Helpers in `profile.ts` MUST only emit predicates listed here.
// The smoke test asserts EMITTED_PREDICATES ⊆ PREDICATE_REGISTRY keys.
export const EMITTED_PREDICATES: readonly string[] = Object.freeze([
  // static (one per helper)
  "person.identity",
  "person.career",
  "person.board_seat",
  "person.education",
  "person.family_tie",
  "person.conference",
  // dynamic: person.preference.{key}
  "person.preference.communication_channel",
  "person.preference.contact_time",
  "person.preference.meeting_format",
  "person.preference.gift_dietary",
  "person.preference.gift_allergies",
  "person.preference.coffee_order",
  "person.preference.travel_class",
  "person.preference.hotel_brand",
  "person.preference.airline_status",
  // dynamic: person.interest.{category}
  "person.interest.topic", "person.interest.sport", "person.interest.team",
  "person.interest.book", "person.interest.author", "person.interest.podcast",
  "person.interest.music", "person.interest.artist", "person.interest.film",
  "person.interest.show", "person.interest.hobby", "person.interest.cause",
  // dynamic: person.lifestyle.{key}
  "person.lifestyle.runs", "person.lifestyle.cycles", "person.lifestyle.surfs",
  "person.lifestyle.skis", "person.lifestyle.golfs", "person.lifestyle.yoga",
  "person.lifestyle.meditates", "person.lifestyle.cooks", "person.lifestyle.collects",
  "person.lifestyle.pet", "person.lifestyle.marathon", "person.lifestyle.ironman",
  // dynamic: person.travel.{kind}
  "person.travel.frequent_city", "person.travel.home_base",
  "person.travel.recent_trip", "person.travel.upcoming_trip", "person.travel.airport_hub",
  // dynamic: person.goal.{kind}
  "person.goal.short_term", "person.goal.long_term", "person.goal.hiring",
  "person.goal.fundraising", "person.goal.investing_thesis", "person.goal.expansion_market",
  // dynamic: person.hook.{kind}
  "person.hook.recent_news", "person.hook.shared_connection", "person.hook.shared_school",
  "person.hook.shared_employer", "person.hook.shared_interest", "person.hook.recent_post",
  "person.hook.life_event", "person.hook.opinion_quoted",
  // dynamic: person.appreciation.{kind}
  "person.appreciation.compliment_topic", "person.appreciation.gift_idea",
  "person.appreciation.charity_supported", "person.appreciation.cause_advocated",
  "person.appreciation.recognition_received",
]);
