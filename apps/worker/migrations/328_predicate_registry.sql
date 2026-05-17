-- Task #4: predicate_registry table + seed rows.
  --
  -- Single source of truth for how the dashboard renders any fact predicate
  -- (label / icon / formatter / category / value_type). Mirrored in TS at
  -- apps/worker/src/entities/profile-predicates.ts — the smoke test enforces
  -- that every helper-emitted predicate resolves through this table.
  --
  -- Adding a new predicate is a TWO-file change:
  --   1. append it to PREDICATE_REGISTRY in profile-predicates.ts
  --   2. add the matching INSERT OR IGNORE row below

  CREATE TABLE IF NOT EXISTS predicate_registry (
    predicate    TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    icon         TEXT NOT NULL,
    formatter    TEXT NOT NULL,
    category     TEXT NOT NULL,
    value_type   TEXT NOT NULL,
    description  TEXT,
    seeded_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_predreg_category ON predicate_registry(category);

  INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity', 'Identity snapshot', 'user', 'json', 'identity', 'json', 'Snapshot of person_identity row.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.full_name', 'Full name', 'user', 'text', 'identity', 'text', 'Legal or commonly used full name.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.preferred_name', 'Preferred name', 'user', 'text', 'identity', 'text', 'What the person prefers to be called.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.pronouns', 'Pronouns', 'user-circle', 'text', 'identity', 'json', 'Pronouns triple (subject/object/possessive).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.birth_year', 'Birth year', 'cake', 'year', 'identity', 'year', 'Year of birth (no full DOB stored).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.nationality', 'Nationality', 'flag', 'flag', 'identity', 'country_iso2', 'ISO-3166-1 alpha-2 nationality.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.languages', 'Languages', 'languages', 'list', 'identity', 'json', 'Spoken languages with proficiency.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.timezone', 'Timezone', 'clock', 'text', 'identity', 'text', 'IANA tz database name.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.location_city', 'City', 'map-pin', 'text', 'identity', 'text', 'Current city of residence.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.location_country', 'Country', 'globe', 'flag', 'identity', 'country_iso2', 'Current country of residence.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.identity.headshot_url', 'Headshot', 'image', 'avatar', 'identity', 'url', 'Public headshot image URL.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.career', 'Career entry', 'briefcase', 'json', 'career', 'json', 'Snapshot of a career_history row.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.board_seat', 'Board seat', 'users', 'json', 'career', 'json', 'Snapshot of a board_seats row.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.education', 'Education', 'graduation-cap', 'json', 'education', 'json', 'Snapshot of an education_history row.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.family_tie', 'Family tie', 'heart', 'json', 'family', 'json', 'Snapshot of a family_ties row.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.conference', 'Conference', 'calendar', 'json', 'conference', 'json', 'Snapshot of a conference_attendance row.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.communication_channel', 'Communication channel', 'message-circle', 'text', 'preference', 'text', 'Preferred contact channel (email/text/dm/voice).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.contact_time', 'Best time to reach', 'clock', 'text', 'preference', 'text', 'Preferred contact window or day.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.meeting_format', 'Meeting format', 'video', 'text', 'preference', 'text', 'In-person, video, phone, async.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.gift_dietary', 'Dietary', 'salad', 'text', 'preference', 'text', 'Vegan/vegetarian/keto/halal/etc.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.gift_allergies', 'Allergies', 'alert-triangle', 'list', 'preference', 'json', 'Food/material allergies to avoid for gifting.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.coffee_order', 'Coffee order', 'coffee', 'text', 'preference', 'text', 'Usual coffee order.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.travel_class', 'Travel class', 'plane', 'text', 'preference', 'text', 'Preferred flight cabin class.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.hotel_brand', 'Hotel brand', 'bed', 'text', 'preference', 'text', 'Preferred hotel chain or brand.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.preference.airline_status', 'Airline status', 'plane', 'text', 'preference', 'text', 'Frequent-flyer status / preferred carrier.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.topic', 'Topic', 'tag', 'badge', 'interest', 'text', 'Topic of interest.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.sport', 'Sport', 'trophy', 'badge', 'interest', 'text', 'Sport played or followed.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.team', 'Team', 'shield', 'badge', 'interest', 'text', 'Favorite team.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.book', 'Book', 'book', 'text', 'interest', 'text', 'Book the person recommends or read.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.author', 'Author', 'feather', 'text', 'interest', 'text', 'Favorite author.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.podcast', 'Podcast', 'mic', 'text', 'interest', 'text', 'Podcast the person listens to.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.music', 'Music genre', 'music', 'badge', 'interest', 'text', 'Preferred music genre.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.artist', 'Artist', 'music', 'text', 'interest', 'text', 'Favorite musical artist.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.film', 'Film', 'film', 'text', 'interest', 'text', 'Favorite film.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.show', 'TV show', 'tv', 'text', 'interest', 'text', 'Favorite TV show.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.hobby', 'Hobby', 'puzzle', 'badge', 'interest', 'text', 'Hobby outside of work.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.interest.cause', 'Cause', 'heart-handshake', 'badge', 'interest', 'text', 'Cause the person supports.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.runs', 'Runs', 'footprints', 'text', 'lifestyle', 'json', 'Is a runner.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.cycles', 'Cycles', 'bike', 'text', 'lifestyle', 'json', 'Cycles.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.surfs', 'Surfs', 'waves', 'text', 'lifestyle', 'json', 'Surfs.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.skis', 'Skis', 'snowflake', 'text', 'lifestyle', 'json', 'Skis or snowboards.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.golfs', 'Golfs', 'flag', 'text', 'lifestyle', 'json', 'Plays golf.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.yoga', 'Yoga', 'activity', 'text', 'lifestyle', 'json', 'Practices yoga.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.meditates', 'Meditates', 'leaf', 'text', 'lifestyle', 'json', 'Meditates regularly.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.cooks', 'Cooks', 'chef-hat', 'text', 'lifestyle', 'json', 'Cooks for fun.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.collects', 'Collects', 'package', 'text', 'lifestyle', 'json', 'Collects something (art, wine, watches…).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.pet', 'Pet', 'paw-print', 'text', 'lifestyle', 'json', 'Has a pet.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.marathon', 'Marathon', 'medal', 'text', 'lifestyle', 'json', 'Completed marathon.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.lifestyle.ironman', 'Ironman', 'medal', 'text', 'lifestyle', 'json', 'Completed Ironman triathlon.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.travel.frequent_city', 'Frequent city', 'map-pin', 'text', 'travel', 'text', 'City the person frequently travels to.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.travel.home_base', 'Home base', 'home', 'text', 'travel', 'text', 'Stated home base.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.travel.recent_trip', 'Recent trip', 'plane', 'text', 'travel', 'text', 'Recent trip place + date window.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.travel.upcoming_trip', 'Upcoming trip', 'plane', 'text', 'travel', 'text', 'Announced upcoming trip.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.travel.airport_hub', 'Airport hub', 'plane', 'text', 'travel', 'text', 'Home airport (IATA code).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.goal.short_term', 'Short-term goal', 'target', 'text', 'goal', 'text', 'Goal stated for <12 months.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.goal.long_term', 'Long-term goal', 'target', 'text', 'goal', 'text', 'Goal stated for 12+ months.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.goal.hiring', 'Hiring goal', 'user-plus', 'text', 'goal', 'text', 'Stated hiring need.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.goal.fundraising', 'Fundraising goal', 'dollar-sign', 'text', 'goal', 'text', 'Stated fundraising plan.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.goal.investing_thesis', 'Investing thesis', 'lightbulb', 'text', 'goal', 'text', 'Stated investing thesis.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.goal.expansion_market', 'Expansion market', 'map', 'text', 'goal', 'text', 'Stated market expansion.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.recent_news', 'Recent news', 'newspaper', 'text', 'hook', 'text', 'Recent news about the person.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.shared_connection', 'Shared connection', 'users', 'text', 'hook', 'text', 'Mutual contact you can mention.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.shared_school', 'Shared school', 'graduation-cap', 'text', 'hook', 'text', 'Shared alma mater.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.shared_employer', 'Shared employer', 'briefcase', 'text', 'hook', 'text', 'Shared former or current employer.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.shared_interest', 'Shared interest', 'tag', 'text', 'hook', 'text', 'Shared interest or hobby.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.recent_post', 'Recent post', 'message-square', 'text', 'hook', 'text', 'Recent public post by the person.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.life_event', 'Life event', 'sparkles', 'text', 'hook', 'text', 'Life event (job change, baby, move).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.hook.opinion_quoted', 'Opinion quoted', 'quote', 'text', 'hook', 'text', 'Public statement on a topic.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.appreciation.compliment_topic', 'Compliment topic', 'thumbs-up', 'text', 'appreciation', 'text', 'Topic the person likes to be complimented on.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.appreciation.gift_idea', 'Gift idea', 'gift', 'text', 'appreciation', 'text', 'Concrete gift idea.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.appreciation.charity_supported', 'Charity supported', 'heart', 'text', 'appreciation', 'text', 'Charity the person supports.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.appreciation.cause_advocated', 'Cause advocated', 'megaphone', 'text', 'appreciation', 'text', 'Cause the person publicly advocates.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('person.appreciation.recognition_received', 'Recognition received', 'award', 'text', 'appreciation', 'text', 'Public award/recognition received.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('name', 'Name', 'user', 'text', 'identity', 'text', 'Display name (extractor field).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('title', 'Title', 'briefcase', 'text', 'career', 'text', 'Job title (extractor field).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('role', 'Role', 'briefcase', 'text', 'career', 'text', 'Functional role.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('employer', 'Employer', 'building', 'text', 'career', 'text', 'Current employer name.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('company', 'Company', 'building', 'text', 'career', 'text', 'Alias for employer in some extractors.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('headline', 'Headline', 'type', 'text', 'identity', 'text', 'LinkedIn-style headline.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('summary', 'Summary', 'file-text', 'text', 'identity', 'text', 'Bio / summary paragraph.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('bio', 'Bio', 'file-text', 'text', 'identity', 'text', 'Profile bio.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('description', 'Description', 'file-text', 'text', 'firm', 'text', 'Org/company description.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('location', 'Location', 'map-pin', 'text', 'identity', 'text', 'Stated location string.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('city', 'City', 'map-pin', 'text', 'identity', 'text', 'City (extractor field).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('region', 'Region', 'map', 'text', 'identity', 'text', 'State/region.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('country', 'Country', 'globe', 'text', 'identity', 'text', 'Country (name string).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('country_iso2', 'Country (ISO)', 'flag', 'flag', 'identity', 'country_iso2', 'ISO 3166-1 alpha-2 country.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('timezone', 'Timezone', 'clock', 'text', 'identity', 'text', 'Timezone (extractor field).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('email', 'Email', 'mail', 'link', 'contact', 'email', 'Email address.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('phone', 'Phone', 'phone', 'text', 'contact', 'text', 'Phone number (E.164 preferred).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('linkedin_url', 'LinkedIn', 'linkedin', 'link', 'contact', 'url', 'LinkedIn profile URL.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('twitter_url', 'Twitter', 'twitter', 'link', 'contact', 'url', 'Twitter/X profile URL.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('twitter_handle', 'Twitter handle', 'twitter', 'text', 'contact', 'text', 'Twitter/X handle.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('github_url', 'GitHub', 'github', 'link', 'contact', 'url', 'GitHub profile URL.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('github_handle', 'GitHub handle', 'github', 'text', 'contact', 'text', 'GitHub handle.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('website', 'Website', 'link', 'link', 'contact', 'url', 'Personal/firm website URL.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('primary_domain', 'Primary domain', 'globe', 'text', 'firm', 'text', 'Canonical apex domain.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('sector', 'Sector', 'layers', 'badge', 'firm', 'text', 'Sector / vertical tag.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('stage', 'Stage', 'trending-up', 'badge', 'firm', 'text', 'Investment stage focus.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('check_size_min_usd', 'Min check (USD)', 'dollar-sign', 'usd', 'firm', 'currency_usd', 'Minimum typical check size.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('check_size_max_usd', 'Max check (USD)', 'dollar-sign', 'usd', 'firm', 'currency_usd', 'Maximum typical check size.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('fund_size_usd', 'Fund size (USD)', 'dollar-sign', 'usd', 'firm', 'currency_usd', 'Most recent fund size.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('founded_year', 'Founded year', 'calendar', 'year', 'firm', 'year', 'Year founded.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('founded_at', 'Founded', 'calendar', 'date', 'firm', 'date', 'Founding date (full).');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('funding_stage', 'Funding stage', 'trending-up', 'badge', 'firm', 'text', 'Latest funding stage.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('total_funding_usd', 'Total funding (USD)', 'dollar-sign', 'usd', 'firm', 'currency_usd', 'Total funding raised.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('last_round_usd', 'Last round (USD)', 'dollar-sign', 'usd', 'firm', 'currency_usd', 'Most recent round amount.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('hq_city', 'HQ city', 'map-pin', 'text', 'firm', 'text', 'HQ city.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('hq_country_iso2', 'HQ country (ISO)', 'flag', 'flag', 'firm', 'country_iso2', 'HQ country ISO code.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('employees', 'Employees', 'users', 'text', 'firm', 'number', 'Employee headcount or band.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('industry', 'Industry', 'layers', 'badge', 'firm', 'text', 'Industry classification.');
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES ('display_name', 'Display name', 'user', 'text', 'identity', 'text', 'Canonical display name.');
