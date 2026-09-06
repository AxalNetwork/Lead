// TS types matching the unified entity DDL (migrations 200–208).
// Task #4: re-export the rich-profile write helpers under a single
// EntityService facade so callers can `import { EntityService } from
// "./entities/model"` for every structured profile write.
export { EntityService } from "./profile";
export { PREDICATE_REGISTRY, PREDICATE_MAP, EMITTED_PREDICATES, getPredicateMeta, } from "./profile-predicates";
