// Task #5: Cap-Table service surface.
//
// All cap-table writes flow through these helpers. The route layer
// (routes/cap_table.ts) only reads from the structured tables — it
// never composes its own SQL writes.

export { persistCapTableSnapshot } from "./persist";
export { buildDilutionWaterfall, mergeDealEventsIntoTimeline, projectTrajectory } from "./dilution";
export type { DilutionStep, DilutionHolder, SnapshotForDilution, DealEventForDilution, TrajectoryProjection } from "./dilution";
export { inferCapTableFromDelawareSosMetadata } from "./deSosMetadata";
export { extractS1CapTable } from "./s1CapTableParser";
export { extractDelawareCoi } from "./deCoiParser";
export { extractSecondaryListing } from "./secondaryListingParser";
export { inferCapTableFromFormD, sweepFormDInferenceForCompany } from "./formDInference";
export { inferCapTableFromDeal, sweepPressInferenceForCompany } from "./pressInference";
export { inferCapTableFromS1, inferCapTableFromS1Html } from "./s1Inference";
export { inferCapTableFromDeCoi } from "./deCoiInference";
export { inferCapTableFromSecondaryListing } from "./secondaryListingInference";
export { sweepS1InferenceForCompany } from "./s1Sweep";
export type {
  CapTableSourceKind, CapTableHolderInput, CapTableSnapshotInput, CapTablePersistResult,
  HolderClass, SecurityType,
} from "./types";
export { DEFAULT_CONFIDENCE } from "./types";
