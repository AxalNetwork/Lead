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

// Stub — returns null. Kind is registered so rules can be created and
// the queue/diff path stays uniform; semantics implemented in a follow-up.
const stub: EvaluatorFn = async () => null;

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
  // Stubs — implemented as follow-ups. Rules can still be created/saved.
  new_portfolio_addition: stub,
  adverse_media: stub,
  funding_event: stub,
  new_tweet: stub,
  new_podcast: stub,
  new_post: stub,
  prediction_above_threshold: stub,
  relationship_change: stub,
};

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
