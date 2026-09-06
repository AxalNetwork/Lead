// Task #3: thin plugin wrapper for kind=executive_hire. Delegates to the
// generic plugin which drives candidate selection from taxonomy
// roles+targets and scoring via the person-graph scorer for person
// targets. Kept as a discrete file so the plugin-per-kind contract
// is satisfied and future per-kind customization has a home.
import { makeGenericPlugin } from "./_generic";
export const ExecutiveHirePlugin = makeGenericPlugin("executive_hire");
