-- Task #14: track a hash of the reference-graph source tables so the
-- nightly sweep can rebuild reference_candidates when the graph changes
-- (publication / conference / accelerator / board / career inputs)
-- independently of verification-claim deltas.
ALTER TABLE person_verification_state ADD COLUMN reference_graph_hash TEXT;
