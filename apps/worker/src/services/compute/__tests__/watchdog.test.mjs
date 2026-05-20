// Task #9: heartbeat watchdog reassigns open assignments on missed
// heartbeats, and marks deadline-elapsed in-flight rows timeout.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runComputeWatchdog, HEARTBEAT_FRESH_MS } from "../../../../test-dist/services/compute/dispatcher.js";

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        _binds: [],
        bind(...args) { this._binds = args; return this; },
        async run() {
          // Stale-node disable: UPDATE compute_nodes SET enabled=0 ... WHERE id=?
          if (/UPDATE compute_nodes\s+SET enabled = 0/.test(sql)) {
            const id = this._binds[0];
            const n = state.nodes.find((x) => x.id === id);
            if (n) { n.enabled = 0; n.last_error = "heartbeat_timeout"; }
            return { success: true };
          }
          // Reassign open: UPDATE compute_job_assignments SET status='reassigned'...
          if (/SET status = 'reassigned'/.test(sql)) {
            const id = this._binds[0];
            const a = state.assignments.find((x) => x.id === id);
            if (a) { a.status = "reassigned"; a.error = "node_heartbeat_timeout"; }
            return { success: true };
          }
          // Zero active_jobs on disabled node
          if (/SET current_active_jobs = 0/.test(sql)) {
            const id = this._binds[0];
            const n = state.nodes.find((x) => x.id === id);
            if (n) n.current_active_jobs = 0;
            return { success: true };
          }
          // Deadline timeout: SET status='timeout'
          if (/SET status = 'timeout'/.test(sql)) {
            const id = this._binds[0];
            const a = state.assignments.find((x) => x.id === id);
            if (a) { a.status = "timeout"; a.error = "deadline_exceeded"; }
            return { success: true };
          }
          // Decrement on timeout
          if (/SET current_active_jobs = MAX\(0, current_active_jobs - 1\)/.test(sql)) {
            const id = this._binds[0];
            const n = state.nodes.find((x) => x.id === id);
            if (n) n.current_active_jobs = Math.max(0, n.current_active_jobs - 1);
            return { success: true };
          }
          return { success: true };
        },
        async first() { return null; },
        async all() {
          // Stale enabled nodes
          if (/FROM compute_nodes\s+WHERE enabled = 1/.test(sql)) {
            const cutoff = this._binds[0];
            return { results: state.nodes.filter((n) =>
              n.enabled === 1 && (!n.last_heartbeat_at || n.last_heartbeat_at < cutoff))
              .map((n) => ({ id: n.id })) };
          }
          // Open assignments for a node
          if (/FROM compute_job_assignments\s+WHERE node_id = \? AND status IN/.test(sql)) {
            const id = this._binds[0];
            return { results: state.assignments
              .filter((a) => a.node_id === id && (a.status === "dispatched" || a.status === "running"))
              .map((a) => ({ id: a.id, job_id: a.job_id, job_type: a.job_type })) };
          }
          // Deadline-elapsed assignments — emulate by walking state.
          if (/deadline_at < datetime\('now'\)/.test(sql)) {
            const now = state.now ?? Date.now();
            return { results: state.assignments
              .filter((a) => (a.status === "dispatched" || a.status === "running") && Date.parse(a.deadline_at) < now)
              .map((a) => ({ id: a.id, node_id: a.node_id })) };
          }
          return { results: [] };
        },
      };
    },
  };
}

test("stale node is disabled and open assignments reassigned", async () => {
  const stale = new Date(Date.now() - HEARTBEAT_FRESH_MS - 5000).toISOString();
  const fresh = new Date().toISOString();
  const state = {
    nodes: [
      { id: "n1", enabled: 1, last_heartbeat_at: stale, last_error: null, current_active_jobs: 2 },
      { id: "n2", enabled: 1, last_heartbeat_at: fresh, last_error: null, current_active_jobs: 0 },
    ],
    assignments: [
      { id: "a1", node_id: "n1", job_id: "j1", job_type: "vision_ocr", status: "dispatched", deadline_at: new Date(Date.now()+60000).toISOString() },
      { id: "a2", node_id: "n1", job_id: "j2", job_type: "vision_ocr", status: "running",    deadline_at: new Date(Date.now()+60000).toISOString() },
      { id: "a3", node_id: "n2", job_id: "j3", job_type: "vision_ocr", status: "running",    deadline_at: new Date(Date.now()+60000).toISOString() },
    ],
  };
  const r = await runComputeWatchdog({ DB: fakeDb(state) });
  assert.equal(r.nodes_disabled, 1);
  assert.equal(r.assignments_reassigned, 2);
  const n1 = state.nodes.find((n) => n.id === "n1");
  assert.equal(n1.enabled, 0);
  assert.equal(n1.last_error, "heartbeat_timeout");
  const a3 = state.assignments.find((a) => a.id === "a3");
  assert.equal(a3.status, "running"); // untouched
});

test("deadline-elapsed in-flight is marked timeout", async () => {
  const fresh = new Date().toISOString();
  const state = {
    nodes: [{ id: "n1", enabled: 1, last_heartbeat_at: fresh, last_error: null, current_active_jobs: 1 }],
    assignments: [
      { id: "a1", node_id: "n1", job_id: "j1", job_type: "vision_ocr", status: "running", deadline_at: new Date(Date.now()-1000).toISOString() },
    ],
    now: Date.now(),
  };
  const r = await runComputeWatchdog({ DB: fakeDb(state) }, state.now);
  assert.equal(r.assignments_timed_out, 1);
  const a1 = state.assignments[0];
  assert.equal(a1.status, "timeout");
  assert.equal(a1.error, "deadline_exceeded");
});
