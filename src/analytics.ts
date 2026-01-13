import { DurableObject } from "cloudflare:workers";
import { type Env, getUser, getUserAccount } from "./auth";

// ==================== TYPES ====================

interface AnalyticsDatapoint {
  id: number;
  timestamp: number;
  username: string | null;
  profile_picture: string | null;
  owner: string;
  repo: string;
  page: string;
  path: string;
  user_agent: string;
  accept: string;
  is_api: boolean;
  user_private_granted: boolean;
  user_premium: boolean;
}

interface RetentionCohort {
  cohort_week: string; // e.g., "2024-W01"
  cohort_size: number;
  week_1_retained: number; // percentage
  week_2_retained: number;
  week_3_retained: number;
  week_4_retained: number;
}

interface PremiumUser {
  username: string;
  profile_picture: string | null;
  last_active_date: string;
  request_count: number;
}

interface AnalyticsStats {
  total_requests: number;
  unique_users: number;
  api_requests: number;
  browser_requests: number;
  // DAU/MAU metrics
  dau: number;
  wau: number;
  mau: number;
  dau_mau_ratio: number; // "stickiness" - healthy SaaS is 20-50%
  dau_wau_ratio: number;
  // User type metrics
  unique_premium_users: number;
  unique_private_users: number;
  premium_to_private_ratio: number; // percentage of premium users compared to private users
  premium_users_list: PremiumUser[];
  // Retention cohorts
  retention_cohorts: RetentionCohort[];
  top_repos: { repo: string; count: number }[];
  top_users: {
    username: string;
    profile_picture: string | null;
    count: number;
    user_private_granted: boolean;
    user_premium: boolean;
  }[];
  requests_by_hour: { hour: string; count: number }[];
  requests_by_day: { day: string; count: number }[];
  unique_users_by_day: { day: string; count: number }[];
  requests_by_page: { page: string; count: number }[];
}

interface UserRepos {
  repos: { repo: string; count: number }[];
}

// ==================== DURABLE OBJECT ====================

export class AnalyticsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.initializeDatabase();
  }

  private initializeDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        username TEXT,
        profile_picture TEXT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        page TEXT NOT NULL,
        path TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        accept TEXT NOT NULL,
        is_api INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON analytics(timestamp)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_owner_repo ON analytics(owner, repo)
    `);

    // Migration: add user_private_granted and user_premium columns
    try {
      this.sql.exec(
        `ALTER TABLE analytics ADD COLUMN user_private_granted INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists
    }
    try {
      this.sql.exec(
        `ALTER TABLE analytics ADD COLUMN user_premium INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists
    }
  }

  async log(data: Omit<AnalyticsDatapoint, "id" | "timestamp">) {
    this.sql.exec(
      `INSERT INTO analytics (timestamp, username, profile_picture, owner, repo, page, path, user_agent, accept, is_api, user_private_granted, user_premium)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      data.username,
      data.profile_picture,
      data.owner,
      data.repo,
      data.page,
      data.path,
      data.user_agent,
      data.accept,
      data.is_api ? 1 : 0,
      data.user_private_granted ? 1 : 0,
      data.user_premium ? 1 : 0,
    );
  }

  async getStats(days: number = 30): Promise<AnalyticsStats> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const totalRequests =
      (this.sql
        .exec(
          `SELECT COUNT(*) as count FROM analytics WHERE timestamp > ?`,
          since,
        )
        .toArray()[0]?.count as number) || 0;

    const uniqueUsers =
      (this.sql
        .exec(
          `SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL`,
          since,
        )
        .toArray()[0]?.count as number) || 0;

    const apiRequests =
      (this.sql
        .exec(
          `SELECT COUNT(*) as count FROM analytics WHERE timestamp > ? AND is_api = 1`,
          since,
        )
        .toArray()[0]?.count as number) || 0;

    const browserRequests =
      (this.sql
        .exec(
          `SELECT COUNT(*) as count FROM analytics WHERE timestamp > ? AND is_api = 0`,
          since,
        )
        .toArray()[0]?.count as number) || 0;

    const topRepos = this.sql
      .exec(
        `SELECT owner || '/' || repo as repo, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY owner, repo ORDER BY count DESC LIMIT 10`,
        since,
      )
      .toArray() as { repo: string; count: number }[];

    const topUsers = this.sql
      .exec(
        `SELECT username, profile_picture, COUNT(*) as count, MAX(user_private_granted) as user_private_granted, MAX(user_premium) as user_premium
         FROM analytics WHERE timestamp > ? AND username IS NOT NULL
         GROUP BY username ORDER BY count DESC LIMIT 10`,
        since,
      )
      .toArray()
      .map((row: any) => ({
        username: row.username as string,
        profile_picture: row.profile_picture as string | null,
        count: row.count as number,
        user_private_granted: Boolean(row.user_private_granted),
        user_premium: Boolean(row.user_premium),
      }));

    // Requests by hour (last 24 hours)
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    const requestsByHour = this.sql
      .exec(
        `SELECT strftime('%H', timestamp/1000, 'unixepoch') as hour, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY hour ORDER BY hour`,
        last24h,
      )
      .toArray() as { hour: string; count: number }[];

    // Requests by day (last N days)
    const requestsByDay = this.sql
      .exec(
        `SELECT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch') as day, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY day ORDER BY day`,
        since,
      )
      .toArray() as { day: string; count: number }[];

    // Unique users by day (last N days)
    const uniqueUsersByDay = this.sql
      .exec(
        `SELECT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch') as day, COUNT(DISTINCT username) as count
         FROM analytics WHERE timestamp > ? AND username IS NOT NULL
         GROUP BY day ORDER BY day`,
        since,
      )
      .toArray() as { day: string; count: number }[];

    // Requests by page type
    const requestsByPage = this.sql
      .exec(
        `SELECT page, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY page ORDER BY count DESC`,
        since,
      )
      .toArray() as { page: string; count: number }[];

    // DAU/WAU/MAU calculations
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const dau =
      (this.sql
        .exec(
          `SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL`,
          oneDayAgo,
        )
        .toArray()[0]?.count as number) || 0;

    const wau =
      (this.sql
        .exec(
          `SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL`,
          oneWeekAgo,
        )
        .toArray()[0]?.count as number) || 0;

    const mau =
      (this.sql
        .exec(
          `SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL`,
          oneMonthAgo,
        )
        .toArray()[0]?.count as number) || 0;

    const dauMauRatio = mau > 0 ? Math.round((dau / mau) * 100) : 0;
    const dauWauRatio = wau > 0 ? Math.round((dau / wau) * 100) : 0;

    // Premium and private user counts
    const uniquePremiumUsers =
      (this.sql
        .exec(
          `SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL AND user_premium = 1`,
          since,
        )
        .toArray()[0]?.count as number) || 0;

    const uniquePrivateUsers =
      (this.sql
        .exec(
          `SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL AND user_private_granted = 1`,
          since,
        )
        .toArray()[0]?.count as number) || 0;

    const premiumToPrivateRatio =
      uniquePrivateUsers > 0
        ? Math.round((uniquePremiumUsers / uniquePrivateUsers) * 100)
        : 0;

    // List of premium users with last active date, sorted by recency
    const premiumUsersList = this.sql
      .exec(
        `SELECT username, profile_picture, MAX(timestamp) as last_active, COUNT(*) as request_count
         FROM analytics
         WHERE username IS NOT NULL AND user_premium = 1
         GROUP BY username
         ORDER BY last_active DESC`,
      )
      .toArray()
      .map((row: any) => ({
        username: row.username as string,
        profile_picture: row.profile_picture as string | null,
        last_active_date: new Date(row.last_active as number).toISOString(),
        request_count: row.request_count as number,
      })) as PremiumUser[];

    // Retention cohorts calculation
    // Get users grouped by the week they were first seen
    const retentionCohorts = this.calculateRetentionCohorts();

    return {
      total_requests: totalRequests,
      unique_users: uniqueUsers,
      api_requests: apiRequests,
      browser_requests: browserRequests,
      dau,
      wau,
      mau,
      dau_mau_ratio: dauMauRatio,
      dau_wau_ratio: dauWauRatio,
      unique_premium_users: uniquePremiumUsers,
      unique_private_users: uniquePrivateUsers,
      premium_to_private_ratio: premiumToPrivateRatio,
      premium_users_list: premiumUsersList,
      retention_cohorts: retentionCohorts,
      top_repos: topRepos,
      top_users: topUsers,
      requests_by_hour: requestsByHour,
      requests_by_day: requestsByDay,
      unique_users_by_day: uniqueUsersByDay,
      requests_by_page: requestsByPage,
    };
  }

  async getAllUsers(): Promise<{ username: string; profile_picture: string | null }[]> {
    const rows = this.sql
      .exec(
        `SELECT username, profile_picture, MAX(timestamp) as last_seen
         FROM analytics
         WHERE username IS NOT NULL
         GROUP BY username
         ORDER BY last_seen DESC`,
      )
      .toArray() as { username: string; profile_picture: string | null }[];

    return rows.map((row) => ({
      username: row.username,
      profile_picture: row.profile_picture,
    }));
  }

  private calculateRetentionCohorts(): RetentionCohort[] {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    // Get first seen timestamp for each user
    const userFirstSeen = this.sql
      .exec(
        `SELECT username, MIN(timestamp) as first_seen
         FROM analytics
         WHERE username IS NOT NULL
         GROUP BY username`,
      )
      .toArray() as { username: string; first_seen: number }[];

    // Group users into weekly cohorts (last 8 weeks, excluding current week)
    const cohorts: Map<
      string,
      { users: Set<string>; firstSeenStart: number }
    > = new Map();

    for (const user of userFirstSeen) {
      // Calculate which week this user was first seen
      const weeksAgo = Math.floor((now - user.first_seen) / weekMs);
      if (weeksAgo < 1 || weeksAgo > 8) continue; // Skip current week and anything older than 8 weeks

      const cohortDate = new Date(user.first_seen);
      const year = cohortDate.getUTCFullYear();
      const weekNum = this.getISOWeek(cohortDate);
      const cohortKey = `${year}-W${weekNum.toString().padStart(2, "0")}`;

      if (!cohorts.has(cohortKey)) {
        // Start of that week
        const weekStart =
          now - weeksAgo * weekMs - ((now - user.first_seen) % weekMs);
        cohorts.set(cohortKey, { users: new Set(), firstSeenStart: weekStart });
      }
      cohorts.get(cohortKey)!.users.add(user.username);
    }

    // For each cohort, calculate retention for weeks 1-4
    const results: RetentionCohort[] = [];

    for (const [cohortKey, cohortData] of cohorts) {
      const cohortUsers = Array.from(cohortData.users);
      if (cohortUsers.length === 0) continue;

      const retentionWeeks: number[] = [];

      for (let week = 1; week <= 4; week++) {
        // Check how many users from this cohort were active in week N after their first week
        const weekStart = cohortData.firstSeenStart + week * weekMs;
        const weekEnd = weekStart + weekMs;

        // Skip future weeks
        if (weekStart > now) {
          retentionWeeks.push(-1); // -1 indicates N/A
          continue;
        }

        // Batch users to avoid exceeding 100 parameter limit (97 users + 2 timestamp params)
        const BATCH_SIZE = 97;
        const activeUsers = new Set<string>();

        for (let i = 0; i < cohortUsers.length; i += BATCH_SIZE) {
          const batch = cohortUsers.slice(i, i + BATCH_SIZE);
          const batchResults = this.sql
            .exec(
              `SELECT DISTINCT username
               FROM analytics
               WHERE username IN (${batch.map(() => "?").join(",")})
                 AND timestamp >= ? AND timestamp < ?`,
              ...batch,
              weekStart,
              weekEnd,
            )
            .toArray() as { username: string }[];

          for (const row of batchResults) {
            activeUsers.add(row.username);
          }
        }

        const retentionPct = Math.round((activeUsers.size / cohortUsers.length) * 100);
        retentionWeeks.push(retentionPct);
      }

      results.push({
        cohort_week: cohortKey,
        cohort_size: cohortUsers.length,
        week_1_retained: retentionWeeks[0],
        week_2_retained: retentionWeeks[1],
        week_3_retained: retentionWeeks[2],
        week_4_retained: retentionWeeks[3],
      });
    }

    // Sort by cohort week descending (most recent first)
    return results.sort((a, b) => b.cohort_week.localeCompare(a.cohort_week));
  }

  private getISOWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  async getRecentRequests(limit: number = 100): Promise<AnalyticsDatapoint[]> {
    return this.sql
      .exec(
        `SELECT id, timestamp, username, profile_picture, owner, repo, page, path, user_agent, accept, is_api, user_private_granted, user_premium
         FROM analytics ORDER BY timestamp DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row: any) => ({
        ...row,
        is_api: Boolean(row.is_api),
        user_private_granted: Boolean(row.user_private_granted),
        user_premium: Boolean(row.user_premium),
      })) as AnalyticsDatapoint[];
  }

  async getReposForUser(username: string, days: number = 30): Promise<UserRepos> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const repos = this.sql
      .exec(
        `SELECT owner || '/' || repo as repo, COUNT(*) as count
         FROM analytics WHERE timestamp > ? AND username = ?
         GROUP BY owner, repo ORDER BY count DESC`,
        since,
        username,
      )
      .toArray() as { repo: string; count: number }[];
    return { repos };
  }
}

// ==================== LOGGING HELPER ====================

export async function logAnalytics(
  request: Request,
  env: Env,
  context: {
    owner: string;
    repo: string;
    page: string;
    path: string;
  },
) {
  const { currentUser } = await getUser(request, env);

  // Skip logging for unauthenticated requests
  if (!currentUser) {
    return;
  }

  const accept = request.headers.get("Accept") || "";
  const userAgent = request.headers.get("User-Agent") || "";
  const isApi =
    !accept.includes("text/html") ||
    userAgent.includes("curl") ||
    userAgent.includes("httpie");

  // Get user account for premium/private flags
  const userAccount = await getUserAccount(String(currentUser.id), env);

  const id = env.ANALYTICS_DO.idFromName("global2");
  const stub = env.ANALYTICS_DO.get(id);

  await stub.log({
    username: currentUser?.login || null,
    profile_picture: currentUser?.avatar_url || null,
    owner: context.owner,
    repo: context.repo,
    page: context.page,
    path: context.path,
    user_agent: userAgent,
    accept,
    is_api: isApi,
    user_private_granted: userAccount?.private_granted || false,
    user_premium: userAccount?.premium || false,
  });
}

// ==================== HTML GENERATION ====================

function generateAnalyticsHTML(stats: AnalyticsStats): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analytics - uithub</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a1a1a;
      color: #f0f0f0;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .header {
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 1px solid #333;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      text-align: center;
    }
    .stat-value {
      font-size: 36px;
      font-weight: 700;
      color: #8b5cf6;
      margin-bottom: 8px;
    }
    .stat-label {
      font-size: 14px;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .stat-hint {
      font-size: 11px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .stat-value.healthy {
      color: #10b981;
    }
    .stat-value.warning {
      color: #f59e0b;
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }
    .chart-card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
    }
    .chart-card h3 {
      margin: 0 0 20px;
      color: #8b5cf6;
    }
    .chart-container {
      position: relative;
      height: 300px;
    }
    .lists-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 24px;
    }
    .list-card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
    }
    .list-card h3 {
      margin: 0 0 20px;
      color: #8b5cf6;
    }
    .list-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      background: #1a1a1a;
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .list-item:last-child {
      margin-bottom: 0;
    }
    .list-item-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
    }
    .list-item-name {
      font-weight: 500;
    }
    .list-item-count {
      font-weight: 700;
      color: #8b5cf6;
    }
    .user-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-left: 8px;
    }
    .badge-premium {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: #fff;
    }
    .badge-private {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #fff;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      opacity: 0.5;
    }
    .list-item-name.clickable {
      cursor: pointer;
      transition: color 0.2s;
    }
    .list-item-name.clickable:hover {
      color: #8b5cf6;
    }
    .repo-actions {
      display: flex;
      gap: 8px;
      margin-left: 12px;
    }
    .repo-btn {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      text-decoration: none;
      transition: opacity 0.2s;
    }
    .repo-btn:hover {
      opacity: 0.8;
    }
    .repo-btn-github {
      background: #333;
      color: #fff;
    }
    .repo-btn-uithub {
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      color: #fff;
    }
    /* Modal styles */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.active {
      display: flex;
    }
    .modal {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      max-width: 600px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .modal-header h3 {
      margin: 0;
      color: #8b5cf6;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .modal-close {
      background: none;
      border: none;
      color: #888;
      font-size: 24px;
      cursor: pointer;
    }
    .modal-close:hover {
      color: #fff;
    }
    .modal-user-link {
      color: #ec4899;
      text-decoration: none;
      font-size: 14px;
    }
    .modal-user-link:hover {
      text-decoration: underline;
    }
    .modal-repo-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      background: #1a1a1a;
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .modal-repo-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .modal-repo-name {
      font-weight: 500;
    }
    .modal-repo-count {
      color: #8b5cf6;
      font-weight: 700;
    }
    .modal-loading {
      text-align: center;
      padding: 40px;
      color: #888;
    }
    .cohort-section {
      margin-bottom: 40px;
    }
    .cohort-card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
    }
    .cohort-card h3 {
      margin: 0 0 20px;
      color: #8b5cf6;
    }
    .cohort-table {
      width: 100%;
      border-collapse: collapse;
    }
    .cohort-table th,
    .cohort-table td {
      padding: 12px;
      text-align: center;
      border-bottom: 1px solid #333;
    }
    .cohort-table th {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
    }
    .cohort-table td:first-child {
      text-align: left;
      font-weight: 500;
    }
    .cohort-table .cohort-size {
      color: #888;
      font-size: 12px;
    }
    .retention-cell {
      border-radius: 6px;
      padding: 8px 12px;
      font-weight: 600;
    }
    .retention-high { background: rgba(16, 185, 129, 0.3); color: #10b981; }
    .retention-medium { background: rgba(245, 158, 11, 0.3); color: #f59e0b; }
    .retention-low { background: rgba(239, 68, 68, 0.3); color: #ef4444; }
    .retention-na { color: #555; }
    @media (max-width: 600px) {
      .charts-grid, .lists-grid {
        grid-template-columns: 1fr;
      }
      .cohort-table {
        font-size: 12px;
      }
      .cohort-table th,
      .cohort-table td {
        padding: 8px 4px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Analytics Dashboard</h1>
      <a href="https://dash.cloudflare.com/080fd9e0587416d2fa30ed1f527e2323/workers/durable-objects/view/5ec4281783cd47af832ee5b50273562d/studio?jurisdiction=none&name=global2" target="_blank" style="color: #8b5cf6; text-decoration: none; font-size: 14px; margin-top: 8px; display: inline-block;">Open DB in Cloudflare Dashboard &rarr;</a>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.total_requests.toLocaleString()}</div>
        <div class="stat-label">Total Requests</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.unique_users.toLocaleString()}</div>
        <div class="stat-label">Unique Users</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.api_requests.toLocaleString()}</div>
        <div class="stat-label">API Requests</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.browser_requests.toLocaleString()}</div>
        <div class="stat-label">Browser Requests</div>
      </div>
    </div>

    <div class="stats-grid" style="margin-bottom: 40px;">
      <div class="stat-card">
        <div class="stat-value">${stats.dau.toLocaleString()}</div>
        <div class="stat-label">DAU (24h)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.wau.toLocaleString()}</div>
        <div class="stat-label">WAU (7d)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.mau.toLocaleString()}</div>
        <div class="stat-label">MAU (30d)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value ${stats.dau_mau_ratio >= 20 ? "healthy" : "warning"}">${stats.dau_mau_ratio}%</div>
        <div class="stat-label">DAU/MAU Ratio</div>
        <div class="stat-hint">${stats.dau_mau_ratio >= 20 ? "Healthy (20%+)" : "Below target"}</div>
      </div>
    </div>

    <div class="stats-grid" style="margin-bottom: 40px;">
      <div class="stat-card">
        <div class="stat-value">${stats.unique_premium_users.toLocaleString()}</div>
        <div class="stat-label">Premium Users</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.unique_private_users.toLocaleString()}</div>
        <div class="stat-label">Private Users</div>
      </div>
      <div class="stat-card">
        <div class="stat-value ${stats.premium_to_private_ratio > 0 ? "healthy" : ""}">${stats.premium_to_private_ratio}%</div>
        <div class="stat-label">Premium / Private</div>
        <div class="stat-hint">Premium users as % of private users</div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h3>Requests by Hour (Last 24h)</h3>
        <div class="chart-container">
          <canvas id="hourlyChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>Requests by Day (Last 30 Days)</h3>
        <div class="chart-container">
          <canvas id="dailyChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>Unique Users by Day (Last 30 Days)</h3>
        <div class="chart-container">
          <canvas id="uniqueUsersChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>Request Types</h3>
        <div class="chart-container">
          <canvas id="typeChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>Page Types</h3>
        <div class="chart-container">
          <canvas id="pageChart"></canvas>
        </div>
      </div>
    </div>

    <div class="cohort-section">
      <div class="cohort-card">
        <h3>Retention Cohorts (Weekly)</h3>
        ${
          stats.retention_cohorts.length === 0
            ? '<div class="empty-state">Not enough data for cohort analysis yet</div>'
            : `
        <table class="cohort-table">
          <thead>
            <tr>
              <th>Cohort</th>
              <th>Users</th>
              <th>Week 1</th>
              <th>Week 2</th>
              <th>Week 3</th>
              <th>Week 4</th>
            </tr>
          </thead>
          <tbody>
            ${stats.retention_cohorts
              .map(
                (cohort) => `
              <tr>
                <td>${cohort.cohort_week}</td>
                <td class="cohort-size">${cohort.cohort_size}</td>
                <td><span class="retention-cell ${cohort.week_1_retained < 0 ? "retention-na" : cohort.week_1_retained >= 40 ? "retention-high" : cohort.week_1_retained >= 20 ? "retention-medium" : "retention-low"}">${cohort.week_1_retained < 0 ? "—" : cohort.week_1_retained + "%"}</span></td>
                <td><span class="retention-cell ${cohort.week_2_retained < 0 ? "retention-na" : cohort.week_2_retained >= 30 ? "retention-high" : cohort.week_2_retained >= 15 ? "retention-medium" : "retention-low"}">${cohort.week_2_retained < 0 ? "—" : cohort.week_2_retained + "%"}</span></td>
                <td><span class="retention-cell ${cohort.week_3_retained < 0 ? "retention-na" : cohort.week_3_retained >= 25 ? "retention-high" : cohort.week_3_retained >= 10 ? "retention-medium" : "retention-low"}">${cohort.week_3_retained < 0 ? "—" : cohort.week_3_retained + "%"}</span></td>
                <td><span class="retention-cell ${cohort.week_4_retained < 0 ? "retention-na" : cohort.week_4_retained >= 20 ? "retention-high" : cohort.week_4_retained >= 10 ? "retention-medium" : "retention-low"}">${cohort.week_4_retained < 0 ? "—" : cohort.week_4_retained + "%"}</span></td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
        `
        }
      </div>
    </div>

    <div class="lists-grid">
      <div class="list-card">
        <h3>Premium Users (by Last Active)</h3>
        ${
          stats.premium_users_list.length === 0
            ? '<div class="empty-state">No premium users yet</div>'
            : stats.premium_users_list
                .map(
                  (user) => `
            <div class="list-item">
              <div class="list-item-left">
                ${
                  user.profile_picture
                    ? `<img src="${user.profile_picture}" alt="${user.username}" class="user-avatar">`
                    : ""
                }
                <div>
                  <span class="list-item-name clickable" onclick="showUserRepos('${user.username}', '${user.profile_picture || ""}')">${user.username}</span>
                  <div style="font-size: 12px; color: #888; margin-top: 2px;">
                    Last active: ${new Date(user.last_active_date).toLocaleDateString()} ${new Date(user.last_active_date).toLocaleTimeString()}
                  </div>
                </div>
              </div>
              <span class="list-item-count">${user.request_count.toLocaleString()} reqs</span>
            </div>
          `,
                )
                .join("")
        }
      </div>
      <div class="list-card">
        <h3>Top Repositories</h3>
        ${
          stats.top_repos.length === 0
            ? '<div class="empty-state">No data yet</div>'
            : stats.top_repos
                .map(
                  (repo) => `
            <div class="list-item">
              <div class="list-item-left">
                <span class="list-item-name">${repo.repo}</span>
                <div class="repo-actions">
                  <a href="https://github.com/${repo.repo}" target="_blank" class="repo-btn repo-btn-github">GitHub</a>
                  <a href="https://uithub.com/${repo.repo}" target="_blank" class="repo-btn repo-btn-uithub">UIThub</a>
                </div>
              </div>
              <span class="list-item-count">${repo.count.toLocaleString()}</span>
            </div>
          `,
                )
                .join("")
        }
      </div>
      <div class="list-card">
        <h3>Top Users</h3>
        ${
          stats.top_users.length === 0
            ? '<div class="empty-state">No data yet</div>'
            : stats.top_users
                .map(
                  (user) => `
            <div class="list-item">
              <div class="list-item-left">
                ${
                  user.profile_picture
                    ? `<img src="${user.profile_picture}" alt="${user.username}" class="user-avatar">`
                    : ""
                }
                <span class="list-item-name clickable" onclick="showUserRepos('${user.username}', '${user.profile_picture || ""}')">${user.username}</span>
                ${user.user_premium ? '<span class="user-badge badge-premium">Premium</span>' : ""}
                ${user.user_private_granted ? '<span class="user-badge badge-private">Private Granted</span>' : ""}
              </div>
              <span class="list-item-count">${user.count.toLocaleString()}</span>
            </div>
          `,
                )
                .join("")
        }
      </div>
    </div>
  </div>

  <!-- User Repos Modal -->
  <div id="userModal" class="modal-overlay" onclick="if(event.target === this) closeModal()">
    <div class="modal">
      <div class="modal-header">
        <h3>
          <img id="modalUserAvatar" src="" alt="" class="user-avatar" style="display:none;">
          <span id="modalUserName"></span>
        </h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div style="margin-bottom: 16px;">
        <a id="modalGithubLink" href="" target="_blank" class="modal-user-link">View on GitHub &rarr;</a>
      </div>
      <div id="modalContent">
        <div class="modal-loading">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#f0f0f0' }
        }
      },
      scales: {
        x: {
          ticks: { color: '#888' },
          grid: { color: '#333' }
        },
        y: {
          ticks: { color: '#888' },
          grid: { color: '#333' }
        }
      }
    };

    // Hourly chart
    const hourlyData = ${JSON.stringify(stats.requests_by_hour)};
    new Chart(document.getElementById('hourlyChart'), {
      type: 'bar',
      data: {
        labels: hourlyData.map(d => d.hour + ':00'),
        datasets: [{
          label: 'Requests',
          data: hourlyData.map(d => d.count),
          backgroundColor: 'rgba(139, 92, 246, 0.6)',
          borderColor: '#8b5cf6',
          borderWidth: 1
        }]
      },
      options: chartOptions
    });

    // Daily chart
    const dailyData = ${JSON.stringify(stats.requests_by_day)};
    new Chart(document.getElementById('dailyChart'), {
      type: 'line',
      data: {
        labels: dailyData.map(d => d.day),
        datasets: [{
          label: 'Requests',
          data: dailyData.map(d => d.count),
          borderColor: '#ec4899',
          backgroundColor: 'rgba(236, 72, 153, 0.1)',
          fill: true,
          tension: 0.3
        }]
      },
      options: chartOptions
    });

    // Unique users by day chart
    const uniqueUsersData = ${JSON.stringify(stats.unique_users_by_day)};
    new Chart(document.getElementById('uniqueUsersChart'), {
      type: 'line',
      data: {
        labels: uniqueUsersData.map(d => d.day),
        datasets: [{
          label: 'Unique Users',
          data: uniqueUsersData.map(d => d.count),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: true,
          tension: 0.3
        }]
      },
      options: chartOptions
    });

    // Type chart
    new Chart(document.getElementById('typeChart'), {
      type: 'doughnut',
      data: {
        labels: ['API', 'Browser'],
        datasets: [{
          data: [${stats.api_requests}, ${stats.browser_requests}],
          backgroundColor: ['#8b5cf6', '#ec4899']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#f0f0f0' }
          }
        }
      }
    });

    // Page types chart
    const pageData = ${JSON.stringify(stats.requests_by_page)};
    const pageColors = [
      '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#3b82f6',
      '#ef4444', '#06b6d4', '#84cc16', '#f97316', '#a855f7'
    ];
    new Chart(document.getElementById('pageChart'), {
      type: 'doughnut',
      data: {
        labels: pageData.map(d => d.page),
        datasets: [{
          data: pageData.map(d => d.count),
          backgroundColor: pageData.map((_, i) => pageColors[i % pageColors.length])
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#f0f0f0' },
            position: 'right'
          }
        }
      }
    });

    // Modal functions
    function showUserRepos(username, profilePicture) {
      const modal = document.getElementById('userModal');
      const modalUserName = document.getElementById('modalUserName');
      const modalUserAvatar = document.getElementById('modalUserAvatar');
      const modalGithubLink = document.getElementById('modalGithubLink');
      const modalContent = document.getElementById('modalContent');

      modalUserName.textContent = username;
      modalGithubLink.href = 'https://github.com/' + username;

      if (profilePicture) {
        modalUserAvatar.src = profilePicture;
        modalUserAvatar.style.display = 'block';
      } else {
        modalUserAvatar.style.display = 'none';
      }

      modalContent.innerHTML = '<div class="modal-loading">Loading...</div>';
      modal.classList.add('active');

      fetch('?user=' + encodeURIComponent(username))
        .then(res => res.json())
        .then(data => {
          if (data.repos.length === 0) {
            modalContent.innerHTML = '<div class="empty-state">No repositories found</div>';
            return;
          }
          modalContent.innerHTML = data.repos.map(repo => \`
            <div class="modal-repo-item">
              <div class="modal-repo-left">
                <span class="modal-repo-name">\${repo.repo}</span>
                <div class="repo-actions">
                  <a href="https://github.com/\${repo.repo}" target="_blank" class="repo-btn repo-btn-github">GitHub</a>
                  <a href="https://uithub.com/\${repo.repo}" target="_blank" class="repo-btn repo-btn-uithub">UIThub</a>
                </div>
              </div>
              <span class="modal-repo-count">\${repo.count.toLocaleString()}</span>
            </div>
          \`).join('');
        })
        .catch(err => {
          modalContent.innerHTML = '<div class="empty-state">Failed to load repositories</div>';
        });
    }

    function closeModal() {
      document.getElementById('userModal').classList.remove('active');
    }

    // Close modal on escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>`;
}

// ==================== HANDLER ====================

export async function handleAnalytics(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "30");

  const id = env.ANALYTICS_DO.idFromName("global2");
  const stub = env.ANALYTICS_DO.get(id);

  // Handle user repos endpoint
  const userParam = url.searchParams.get("user");
  if (userParam) {
    const userRepos = await stub.getReposForUser(userParam, days);
    return Response.json(userRepos);
  }

  const stats = await stub.getStats(days);

  const accept = request.headers.get("Accept") || "";
  if (accept.includes("application/json")) {
    return Response.json(stats);
  }

  return new Response(generateAnalyticsHTML(stats), {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache",
    },
  });
}
