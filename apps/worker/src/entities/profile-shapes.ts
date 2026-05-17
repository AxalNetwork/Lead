// Task #4: Typed shapes for the JSON columns on rich-profile tables.
// Every helper in `profile.ts` serializes through these shapes; nothing
// passes raw `unknown` through `JSON.stringify`.

export interface PronounsShape {
  subject: string;            // 'she' | 'he' | 'they' | ...
  object: string;             // 'her' | 'him' | 'them' | ...
  possessive: string;         // 'her' | 'his' | 'their' | ...
}

export interface LanguageEntry {
  code: string;               // ISO 639-1, e.g. 'en','fr','zh'
  proficiency?: "native" | "fluent" | "working" | "basic";
}

export interface PreferenceValueShape {
  value: string | number | boolean | Record<string, unknown>;
  unit?: string;
}

export interface LifestyleValueShape {
  detail?: string;
  frequency?: "daily" | "weekly" | "monthly" | "occasional";
}

// ---- helper-input shapes (passed to EntityService.* helpers) ----

export interface IdentityInput {
  entityId: string;
  fullName?: string | null;
  preferredName?: string | null;
  pronouns?: PronounsShape | null;
  birthYear?: number | null;
  nationality?: string | null;             // ISO 3166-1 alpha-2
  languages?: LanguageEntry[] | null;
  timezone?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;         // ISO 3166-1 alpha-2
  headshotUrl?: string | null;
  sourceUrl?: string | null;               // nullable iff isOperatorAsserted
  isOperatorAsserted?: boolean;
  confidence?: number;
  observedAt?: string;
}

export interface CareerEntryInput {
  entityId: string;
  organizationEntityId?: string | null;
  organizationName: string;
  roleTitle?: string | null;
  seniority?: string | null;
  department?: string | null;
  startedAt?: string | null;       // ISO date or YYYY-MM
  endedAt?: string | null;
  isCurrent?: boolean;
  summary?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export interface BoardSeatInput {
  entityId: string;
  organizationEntityId?: string | null;
  organizationName: string;
  role?: string | null;
  isIndependent?: boolean;
  committee?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export interface EducationInput {
  entityId: string;
  institution: string;
  degree?: string | null;
  field?: string | null;
  startedYear?: number | null;
  endedYear?: number | null;
  honors?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export type FamilyRelationType =
  | "spouse" | "partner" | "parent" | "child" | "sibling" | "in_law" | "other";

export interface FamilyTieInput {
  entityId: string;
  relationType: FamilyRelationType;
  relatedName: string;
  relatedEntityId?: string | null;
  notes?: string | null;
  isPublic?: boolean;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export interface PreferenceInput {
  entityId: string;
  preferenceKey: string;            // matches a person.preference.* predicate slug
  valueText?: string | null;
  valueJson?: PreferenceValueShape | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export type InterestCategory =
  | "topic" | "sport" | "team" | "book" | "author" | "podcast"
  | "music" | "artist" | "film" | "show" | "hobby" | "cause";

export interface InterestInput {
  entityId: string;
  interestCategory: InterestCategory;
  interestValue: string;
  weight?: number;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export interface LifestyleSignalInput {
  entityId: string;
  signalKey: string;                // matches a person.lifestyle.* predicate slug
  valueText?: string | null;
  valueJson?: LifestyleValueShape | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export type TravelPatternKind =
  | "frequent_city" | "home_base" | "recent_trip" | "upcoming_trip" | "airport_hub";

export interface TravelPatternInput {
  entityId: string;
  patternKind: TravelPatternKind;
  place: string;
  countryIso2?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export interface ConferenceAttendanceInput {
  entityId: string;
  conferenceName: string;
  year: number;
  role?: string | null;
  sessionTopic?: string | null;
  city?: string | null;
  countryIso2?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export type GoalKind =
  | "short_term" | "long_term" | "hiring" | "fundraising"
  | "investing_thesis" | "expansion_market";

export interface GoalInput {
  entityId: string;
  goalKind: GoalKind;
  goalText: string;
  targetDate?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export type ConversationHookKind =
  | "recent_news" | "shared_connection" | "shared_school" | "shared_employer"
  | "shared_interest" | "recent_post" | "life_event" | "opinion_quoted";

export interface ConversationHookInput {
  entityId: string;
  hookKind: ConversationHookKind;
  hookText: string;
  relatedEntityId?: string | null;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}

export type AppreciationSignalKind =
  | "compliment_topic" | "gift_idea" | "charity_supported"
  | "cause_advocated" | "recognition_received";

export interface AppreciationSignalInput {
  entityId: string;
  signalKind: AppreciationSignalKind;
  signalText: string;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}
