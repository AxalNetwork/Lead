// Registry mapping every fixed-enum `trigger_kind` to its evaluator
// module. The taxonomy is closed; new kinds require a code change here
// + a migration that loosens the alert_rules CHECK constraint.

import type { EvalContext, EvaluatedAlert, EvaluatorFn, TriggerKind } from "../types";

import { evalAnyChange } from "./any_change";
import { evalTitleChange } from "./title_change";
import { evalNewEmployer } from "./new_employer";
import { evalGeoChange } from "./geo_change";
import { evalFitScoreChange } from "./fit_score_change";
import { evalIntentScoreChange } from "./intent_score_change";
import { evalDdScoreChange } from "./dd_score_change";
import { evalDdFindingNew } from "./dd_finding_new";
import { evalNewNewsItem } from "./new_news_item";
import { evalNewInvestment } from "./new_investment";
import { evalHandleAdded } from "./handle_added";
import { evalExecutiveChange } from "./executive_change";
import { evalNewPortfolioAddition } from "./new_portfolio_addition";
import { evalAdverseMedia } from "./adverse_media";
import { evalFundingEvent } from "./funding_event";
import { evalNewTweet, evalNewPodcast, evalNewPost } from "./social_post";
import { evalPredictionAboveThreshold } from "./prediction_above_threshold";
import { evalRelationshipChange } from "./relationship_change";
import { evalPartnerMovementMatch } from "./partner_movement_match";
import { evalNewFundMatch } from "./new_fund_match";
import { evalSecFilingMatch } from "./sec_filing_match";
import { evalPeDealMatch } from "./pe_deal_match";

export const EVALUATORS: Record<TriggerKind, EvaluatorFn> = {
  any_change: evalAnyChange,
  title_change: evalTitleChange,
  new_employer: evalNewEmployer,
  geo_change: evalGeoChange,
  fit_score_change: evalFitScoreChange,
  intent_score_change: evalIntentScoreChange,
  dd_score_change: evalDdScoreChange,
  dd_finding_new: evalDdFindingNew,
  new_news_item: evalNewNewsItem,
  new_investment: evalNewInvestment,
  handle_added: evalHandleAdded,
  executive_change: evalExecutiveChange,
  new_portfolio_addition: evalNewPortfolioAddition,
  adverse_media: evalAdverseMedia,
  funding_event: evalFundingEvent,
  new_tweet: evalNewTweet,
  new_podcast: evalNewPodcast,
  new_post: evalNewPost,
  prediction_above_threshold: evalPredictionAboveThreshold,
  relationship_change: evalRelationshipChange,
  partner_movement_match: evalPartnerMovementMatch,
  new_fund_match: evalNewFundMatch,
  sec_filing_match: evalSecFilingMatch,
  pe_deal_match: evalPeDealMatch,
};

// Trigger kinds whose change anchors live in source tables rather than
// in the canonical summary fingerprint. These MUST still be evaluated
// when the fingerprint hasn't moved, otherwise rule fire is silently
// gated by an unrelated signal.
export const SOURCE_DRIVEN_TRIGGERS: ReadonlySet<TriggerKind> = new Set<TriggerKind>([
  "relationship_change",
  "prediction_above_threshold",
  "new_portfolio_addition",
  "funding_event",
  "adverse_media",
  "new_tweet",
  "new_podcast",
  "partner_movement_match",
  "new_fund_match",
  "sec_filing_match",
  "pe_deal_match",
  "new_post",
  "new_news_item",
  "new_investment",
]);

export async function evaluate(kind: TriggerKind, ctx: EvalContext): Promise<EvaluatedAlert | null> {
  const fn = EVALUATORS[kind];
  if (!fn) return null;
  try {
    return await fn(ctx);
  } catch (e) {
    console.warn("trigger.eval failed", kind, ctx.entityId, (e as Error).message);
    return null;
  }
}
