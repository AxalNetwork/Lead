// Task #3: runtime tool-argument validator.
//
// Lightweight JSON-schema-ish validator covering exactly the shapes our
// tool schemas use: object + required[] + properties.{type|enum|maximum}.
// This is intentionally minimal — we don't pull in ajv, but we DO refuse
// to dispatch handlers when args violate the declared shape so the model
// can't smuggle malformed (or malicious) arguments through.
//
// Kept in its own module (no Env / D1 / queue imports) so it can be
// compiled into test-dist for the acceptance harness.

export interface ValidationFailure { ok: false; errors: string[] }
export interface ValidationSuccess { ok: true; value: Record<string, unknown> }
export type ValidationResult = ValidationSuccess | ValidationFailure;

interface PropSpec {
  type?: string;
  enum?: unknown[];
  maximum?: number;
  minimum?: number;
}

export function validateToolArgs(schema: Record<string, unknown>, args: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, errors: ["arguments must be a JSON object"] };
  }
  const obj = args as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null || obj[key] === "") {
      errors.push(`missing required field '${key}'`);
    }
  }
  const props = (schema.properties ?? {}) as Record<string, PropSpec>;
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in obj) || obj[key] === undefined) continue;
    const v = obj[key];
    if (spec.type === "string" && typeof v !== "string") errors.push(`'${key}' must be string`);
    if (spec.type === "number" && typeof v !== "number") errors.push(`'${key}' must be number`);
    if (spec.type === "boolean" && typeof v !== "boolean") errors.push(`'${key}' must be boolean`);
    if (spec.type === "array" && !Array.isArray(v)) errors.push(`'${key}' must be array`);
    if (spec.type === "object" && (typeof v !== "object" || Array.isArray(v) || v === null)) errors.push(`'${key}' must be object`);
    if (Array.isArray(spec.enum) && !spec.enum.includes(v as never)) errors.push(`'${key}' must be one of: ${spec.enum.join("|")}`);
    if (typeof spec.maximum === "number" && typeof v === "number" && v > spec.maximum) errors.push(`'${key}' must be ≤ ${spec.maximum}`);
    if (typeof spec.minimum === "number" && typeof v === "number" && v < spec.minimum) errors.push(`'${key}' must be ≥ ${spec.minimum}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: obj };
}
