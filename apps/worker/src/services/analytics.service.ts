import { AnalyticsRepo } from "../db/analytics.repo";

export class AnalyticsService {
  private repo: AnalyticsRepo;
  constructor(db: D1Database) {
    this.repo = new AnalyticsRepo(db);
  }

  async getSummary() {
    const [
      totalLeads,
      verifiedLeads,
      approvedLeads,
      pendingLeads,
      activeJobs,
      exportsThisWeek,
      jobsCompleted,
      jobsFailed,
      recentLeads,
      recentJobs,
      categories,
    ] = await Promise.all([
      this.repo.countLeads(),
      this.repo.countLeadsByVerified(true),
      this.repo.countLeadsByStatus("approved"),
      this.repo.countLeadsByStatus("pending"),
      this.repo.countActiveJobs(),
      this.repo.countExportsSince(this.daysAgoIso(7)),
      this.repo.countJobsByStatus("completed"),
      this.repo.countJobsByStatus("failed"),
      this.repo.recentLeads(10),
      this.repo.recentJobs(10),
      this.repo.leadsByCategory(),
    ]);
    const verificationRate = totalLeads > 0 ? verifiedLeads / totalLeads : 0;
    const totalFinished = jobsCompleted + jobsFailed;
    const jobSuccessRate = totalFinished > 0 ? jobsCompleted / totalFinished : 0;
    return {
      total_leads: totalLeads,
      verified_leads: verifiedLeads,
      approved_leads: approvedLeads,
      pending_leads: pendingLeads,
      active_jobs: activeJobs,
      exports_count: exportsThisWeek,
      verification_rate: verificationRate,
      job_success_rate: jobSuccessRate,
      recent_leads: recentLeads,
      recent_jobs: recentJobs,
      leads_by_category: categories,
    };
  }

  async getTrends(days: number) {
    return this.repo.dailyLeadCounts(days);
  }

  async getTopSources() {
    return this.repo.topSources(10);
  }

  private daysAgoIso(days: number) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }
}
