export class AnalyticsRepo {
  constructor(private db: D1Database) {}

  async countLeads(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS c FROM leads").first<{ c: number }>();
    return r?.c ?? 0;
  }

  async countLeadsByStatus(status: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = ?")
      .bind(status)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async countLeadsByVerified(verified: boolean): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS c FROM leads WHERE verified = ?")
      .bind(verified ? 1 : 0)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async countActiveJobs(): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running')")
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async countJobsByStatus(status: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = ?")
      .bind(status)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async countExportsSince(iso: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS c FROM exports WHERE created_at >= ?")
      .bind(iso)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async recentLeads(limit: number) {
    const r = await this.db
      .prepare(
        "SELECT id, name, org, source_domain, status, verified, created_at FROM leads ORDER BY created_at DESC LIMIT ?",
      )
      .bind(limit)
      .all();
    return r.results ?? [];
  }

  async recentJobs(limit: number) {
    const r = await this.db
      .prepare("SELECT id, name, source, status, started_at, finished_at FROM jobs ORDER BY started_at DESC LIMIT ?")
      .bind(limit)
      .all();
    return r.results ?? [];
  }

  async leadsByCategory() {
    const r = await this.db
      .prepare("SELECT category, COUNT(*) AS count FROM leads WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC")
      .all<{ category: string; count: number }>();
    return r.results ?? [];
  }

  async topSources(limit: number) {
    const r = await this.db
      .prepare("SELECT source_domain AS domain, COUNT(*) AS lead_count FROM leads WHERE source_domain IS NOT NULL GROUP BY source_domain ORDER BY lead_count DESC LIMIT ?")
      .bind(limit)
      .all<{ domain: string; lead_count: number }>();
    return r.results ?? [];
  }

  async dailyLeadCounts(days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const r = await this.db
      .prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM leads WHERE created_at >= ? GROUP BY day ORDER BY day")
      .bind(since)
      .all<{ day: string; count: number }>();
    return r.results ?? [];
  }
}
