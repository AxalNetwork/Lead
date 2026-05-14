export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  LEAD_QUEUE: Queue<unknown>;
  ALLOWED_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}
