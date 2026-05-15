export default {
  async fetch() {
    return new Response(
      "aidatasignal CF Builds shim. The real Worker is `lead` and is deployed via .github/workflows/deploy-worker.yml using apps/worker/wrangler.toml.",
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};
