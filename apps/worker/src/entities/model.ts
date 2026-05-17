// TS types matching the unified entity DDL (migrations 200–208).

export type EntityKind = "person" | "org";
export type EntityStatus = "active" | "merged" | "soft_deleted" | "dnc";

export type EntityRole =
  | "investor" | "investor_firm" | "angel" | "vc" | "gp" | "lp"
  | "founder" | "operator" | "executive" | "board_member"
  | "advisor" | "employee" | "customer" | "prospect" | "buyer" | "lead"
  | "partner" | "firm" | "fund" | "accelerator" | "company"
  | "account" | "school";

export type ChannelKind = "email" | "phone" | "linkedin" | "twitter" | "github" | "website" | "other";

export type RelKind =
  | "works_at" | "partner_at" | "invested_in" | "led_round" | "co_invested_with"
  | "founded" | "board_of" | "colleague_of" | "school_with"
  | "sourced_by" | "referred" | "customer_of" | "partner_with"
  | "competitor_of" | "acquirer_of";

export type SourceKind = "scrape" | "import" | "manual" | "enrichment" | "ai" | "inferred";

export type Taxonomy = "sector" | "stage" | "geo" | "persona" | "role" | "tech" | "accelerator" | "tag";

export interface EntityRow {
  id: string;
  kind: EntityKind;
  display_name: string | null;
  primary_url: string | null;
  primary_domain: string | null;
  primary_email_key: string | null;
  primary_linkedin_key: string | null;
  primary_twitter_handle: string | null;
  primary_github_handle: string | null;
  quality_score: number;
  status: EntityStatus;
  merged_into_entity_id: string | null;
  last_synced_vec_at: string | null;
  last_synced_search_at: string | null;
  last_summary_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactInput {
  entity_id: string;
  predicate: string;
  value_text?: string | null;
  value_number?: number | null;
  value_json?: unknown;
  value_entity_id?: string | null;
  source_kind: SourceKind;
  source?: string | null;
  evidence_url?: string | null;
  confidence?: number;
  observed_at?: string;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface ChannelInput {
  entity_id: string;
  kind: ChannelKind;
  canonical: string;
  display?: string | null;
  is_primary?: boolean;
  is_verified?: boolean;
  is_dnc?: boolean;
  source?: string | null;
  confidence?: number;
}

export interface TagInput {
  entity_id: string;
  taxonomy: Taxonomy;
  slug: string;
  weight?: number;
  source?: string | null;
}

// Task #4: re-export the rich-profile write helpers under a single
// EntityService facade so callers can `import { EntityService } from
// "./entities/model"` for every structured profile write.
export { EntityService } from "./profile";
export type {
  IdentityInput, CareerEntryInput, BoardSeatInput, EducationInput,
  FamilyTieInput, PreferenceInput, InterestInput, LifestyleSignalInput,
  TravelPatternInput, ConferenceAttendanceInput, GoalInput,
  ConversationHookInput, AppreciationSignalInput,
} from "./profile-shapes";
export {
  PREDICATE_REGISTRY, PREDICATE_MAP, EMITTED_PREDICATES, getPredicateMeta,
} from "./profile-predicates";
export type { PredicateMeta, PredicateValueType } from "./profile-predicates";
