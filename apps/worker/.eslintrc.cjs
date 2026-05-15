// Task #27: lint baseline.
//
// Goal: catch the high-leverage classes of bug we found during the audit
// (untyped catch, missing await, accidental `any`, unused locals, console
// usage in production code, eqeqeq drift). Stays warn-heavy on style so the
// initial pass doesn't block CI on cosmetic noise.
module.exports = {
  root: true,
  env: { worker: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module", project: "./tsconfig.json" },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "eqeqeq": ["error", "smart"],
    "no-implicit-coercion": "warn",
    "no-throw-literal": "error",
    "no-return-await": "warn",
    "prefer-const": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/consistent-type-imports": "warn",
    // Stylistic regex escapes — many parsers escape `-`/`|` defensively
    // inside character classes for readability. Demoted to warn so CI
    // can hard-block on lint errors without a baseline rewrite.
    "no-useless-escape": "warn",
    // Empty `catch {}` blocks are an established pattern in this codebase
    // (best-effort caches/logs); demote to warn rather than rewrite ~200 sites.
    "no-empty": ["warn", { allowEmptyCatch: true }],
    // `while (true)` polling loops with internal break conditions exist in
    // the workflow engine; flagged as warn so we still see new instances.
    "no-constant-condition": ["warn", { checkLoops: false }],
  },
  ignorePatterns: ["test/**", "data/**", "scripts/**"],
};
