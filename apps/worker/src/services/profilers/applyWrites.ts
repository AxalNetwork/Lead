// Task #5: dispatch StructuredWrite[] → EntityService helpers.
// Enrichers never call EntityService directly; this is the single seam
// where the discriminated union becomes a structured-table upsert + facts
// mirror.

import type { Env } from "../../types";
import {
  setPersonIdentity, addCareerEntry, addBoardSeat, addEducation,
  addFamilyTie, addPreference, addInterest, addLifestyleSignal,
  addTravelPattern, addConferenceAttendance, addGoal,
  addConversationHook, addAppreciationSignal,
} from "../../entities/profile";
import type { StructuredWrite } from "./types";

export interface ApplyOutcome {
  applied: number;
  failed: number;
  errors: string[];
}

export async function applyWrites(env: Env, writes: StructuredWrite[]): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { applied: 0, failed: 0, errors: [] };
  for (const w of writes) {
    try {
      await applyOne(env, w);
      out.applied += 1;
    } catch (e) {
      out.failed += 1;
      const msg = (e as Error).message || String(e);
      if (out.errors.length < 10) out.errors.push(`${w.kind}: ${msg.slice(0, 200)}`);
    }
  }
  return out;
}

async function applyOne(env: Env, w: StructuredWrite): Promise<void> {
  switch (w.kind) {
    case "identity":    return setPersonIdentity(env, w.input);
    case "career":      return addCareerEntry(env, w.input);
    case "board_seat":  return addBoardSeat(env, w.input);
    case "education":   return addEducation(env, w.input);
    case "family_tie": {
      // Public-only path through the profiler. Defensive: refuse to apply
      // a private-tie write here even if an enricher mis-builds one.
      if (w.input.isPublic !== true) {
        throw new Error("profiler.applyWrites: family_tie must have isPublic=true (private ties are operator-only)");
      }
      return addFamilyTie(env, w.input);
    }
    case "preference":   return addPreference(env, w.input);
    case "interest":     return addInterest(env, w.input);
    case "lifestyle":    return addLifestyleSignal(env, w.input);
    case "travel":       return addTravelPattern(env, w.input);
    case "conference":   return addConferenceAttendance(env, w.input);
    case "goal":         return addGoal(env, w.input);
    case "hook":         return addConversationHook(env, w.input);
    case "appreciation": return addAppreciationSignal(env, w.input);
  }
}
