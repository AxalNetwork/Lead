// Shared types for the monitoring layer.

import type { CanonicalSummary } from "./summary";
import type { FieldDiff } from "./diff";

export type TriggerKind =
  | "new_employer"
  | "title_change"
  | "new_investment"
  | "new_portfolio_addition"
  | "new_news_item"
  | "adverse_media"
  | "funding_event"
  | "executive_change"
  | "new_tweet"
  | "new_podcast"
  | "new_post"
  | "dd_finding_new"
  | "dd_score_change"
  | "fit_score_change"
  | "intent_score_change"
  | "prediction_above_threshold"
  | "handle_added"
  | "relationship_change"
  | "geo_change"
  | "any_change";

export const ALL_TRIGGER_KINDS: TriggerKind[] = [
  "new_employer","title_change","new_investment","new_portfolio_addition",
  "new_news_item","adverse_media","funding_event","executive_change",
  "new_tweet","new_podcast","new_post","dd_finding_new","dd_score_change",
  "fit_score_change","intent_score_change","prediction_above_threshold",
  "handle_added","relationship_change","geo_change","any_change",
];

export type Channel = "in_app" | "email" | "slack" | "webhook" | "digest";

export interface AlertRuleRow {
  id: string;
  owner_email: string;
  name: string;
  watchlist_id: string | null;
  entity_id: string | null;
  trigger_kind: TriggerKind;
  trigger_config_json: string | null;
  channel: Channel;
  channel_config_json: string | null;
  digest_frequency: "realtime" | "hourly" | "daily" | "weekly" | "off";
  dedupe_window_seconds: number;
  is_active: number;
  last_fired_at: string | null;
  fire_count: number;
}

export interface EvaluatedAlert {
  /** Stable per-trigger identifier used for dedupe (e.g. news_item_id). */
  dedupe_key: string;
  title: string;
  body: string;
  diff: FieldDiff[];
  payload: Record<string, unknown>;
}

export interface EvalContext {
  env: import("../types").Env;
  entityId: string;
  ownerEmail: string;
  oldSummary: CanonicalSummary | null;
  newSummary: CanonicalSummary;
  diff: FieldDiff[];
  ruleConfig: Record<string, unknown>;
  /**
   * Watermark — the prior monitor tick's `last_evaluated_at` for this
   * entity. Source-driven evaluators MUST filter their source-table
   * queries by `> sinceWatermark` so they don't re-emit the same row on
   * every tick (the dedupe window only suppresses for ~1h; the watermark
   * is the durable "we already saw this" anchor).
   */
  sinceWatermark: string | null;
}

export type EvaluatorFn = (ctx: EvalContext) => Promise<EvaluatedAlert | null>;
