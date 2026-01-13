import { DurableObject } from "cloudflare:workers";
import type { Env } from "./auth";

// ==================== TYPES ====================

interface SocialProfile {
  platform_slug: string;
  profile_url: string;
  username_on_platform: string | null;
  follower_count: number | null;
  is_self_proclaimed: boolean;
  is_self_referring: boolean;
  match_reasoning: string;
  profile_snippet: string;
}

interface UserSocialData {
  github_username: string;
  github_url: string;
  profiles: SocialProfile[];
  total_followers: number;
  resolved_at: number;
  resolution_status: "pending" | "running" | "completed" | "failed";
  task_run_id: string | null;
}

interface ParallelTaskResult {
  run: { status: string };
  output?: {
    content?: {
      profiles?: Array<{
        platform_slug: string;
        profile_url: string;
        username_on_platform?: string;
        follower_count?: number;
        is_self_proclaimed: boolean;
        is_self_referring: boolean;
        match_reasoning: string;
        profile_snippet: string;
      }>;
    };
  };
}

// ==================== DURABLE OBJECT ====================

export class SocialsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.initializeDatabase();
  }

  private initializeDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_socials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_username TEXT UNIQUE NOT NULL,
        github_url TEXT NOT NULL,
        profiles_json TEXT NOT NULL DEFAULT '[]',
        total_followers INTEGER NOT NULL DEFAULT 0,
        resolved_at INTEGER,
        resolution_status TEXT NOT NULL DEFAULT 'pending',
        task_run_id TEXT,
        created_at INTEGER NOT NULL,
        failure_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_github_username ON user_socials(github_username);
      CREATE INDEX IF NOT EXISTS idx_total_followers ON user_socials(total_followers DESC);
      CREATE INDEX IF NOT EXISTS idx_resolution_status ON user_socials(resolution_status);
    `);

    // Migration: add failure_reason column if it doesn't exist
    try {
      this.sql.exec(`ALTER TABLE user_socials ADD COLUMN failure_reason TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Migration: add task_started_at column if it doesn't exist
    try {
      this.sql.exec(
        `ALTER TABLE user_socials ADD COLUMN task_started_at INTEGER`,
      );
    } catch (e) {
      // Column already exists, ignore
    }
  }

  async alarm() {
    console.log("[SocialsDO] Alarm triggered, processing users...");

    try {
      // First, check any running tasks for completion
      await this.checkRunningTasks();

      // Then process new users
      await this.processNewUsers();
    } catch (error) {
      console.error("[SocialsDO] Alarm error:", error);
    }

    // Schedule next alarm in 5 minutes
    const nextAlarm = Date.now() + 5 * 60 * 1000;
    await this.ctx.storage.setAlarm(nextAlarm);
    console.log(
      "[SocialsDO] Next alarm scheduled for:",
      new Date(nextAlarm).toISOString(),
    );
  }

  async ensureAlarmSet() {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      const nextAlarm = Date.now() + 60 * 1000; // First alarm in 1 minute
      await this.ctx.storage.setAlarm(nextAlarm);
      console.log(
        "[SocialsDO] Initial alarm set for:",
        new Date(nextAlarm).toISOString(),
      );
    }
  }

  private async checkRunningTasks() {
    const apiKey = this.env.PARALLEL_API_KEY;
    if (!apiKey) {
      console.log("[SocialsDO] No PARALLEL_API_KEY configured");
      return;
    }

    // Include task_started_at to check for stuck tasks
    const runningUsers = this.sql
      .exec(
        `SELECT github_username, task_run_id, task_started_at FROM user_socials WHERE resolution_status = 'running' AND task_run_id IS NOT NULL`,
      )
      .toArray() as {
      github_username: string;
      task_run_id: string;
      task_started_at: number | null;
    }[];

    const now = Date.now();
    const TASK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour timeout

    const results = await Promise.allSettled(
      runningUsers.map(async (user) => {
        // Check if task has been running too long (only if we know when it started)
        if (user.task_started_at) {
          const taskAge = now - user.task_started_at;
          if (taskAge > TASK_TIMEOUT_MS) {
            const reason = `Task timed out after ${Math.round(
              taskAge / 60000,
            )} minutes`;
            this.sql.exec(
              `UPDATE user_socials SET resolution_status = 'failed', resolved_at = ?, failure_reason = ? WHERE github_username = ?`,
              now,
              reason,
              user.github_username,
            );
            console.log(
              `[SocialsDO] Task timed out for ${
                user.github_username
              } (age: ${Math.round(taskAge / 60000)}min)`,
            );
            return user.github_username;
          }
        }

        // Step 1: Check task status (non-blocking)
        const statusResponse = await fetch(
          `https://api.parallel.ai/v1/tasks/runs/${user.task_run_id}`,
          { headers: { "x-api-key": apiKey } },
        );

        if (!statusResponse.ok) {
          const reason = `Status check failed: HTTP ${
            statusResponse.status
          } -- ${await statusResponse.text()}`;
          this.sql.exec(
            `UPDATE user_socials SET resolution_status = 'failed', resolved_at = ?, failure_reason = ? WHERE github_username = ?`,
            now,
            reason,
            user.github_username,
          );
          console.log(
            `[SocialsDO] Status check failed for ${user.github_username} (status: ${statusResponse.status}), marking as failed`,
          );
          return user.github_username;
        }

        const statusResult = (await statusResponse.json()) as {
          run_id: string;
          status: string;
          is_active: boolean;
          error?: { message: string };
        };

        // If still running or queued, leave for next check
        if (statusResult.status === "running" || statusResult.status === "queued") {
          console.log(
            `[SocialsDO] Task for ${user.github_username} still ${statusResult.status}`,
          );
          return user.github_username;
        }

        // If failed, record the error
        if (statusResult.status === "failed") {
          const reason = `Task failed: ${
            statusResult.error?.message || "Unknown error"
          }`;
          this.sql.exec(
            `UPDATE user_socials SET resolution_status = 'failed', resolved_at = ?, failure_reason = ? WHERE github_username = ?`,
            now,
            reason,
            user.github_username,
          );
          console.log(
            `[SocialsDO] Resolution failed for ${user.github_username}: ${reason}`,
          );
          return user.github_username;
        }

        // Step 2: If completed, fetch the result (should return immediately since task is done)
        if (statusResult.status === "completed") {
          const resultResponse = await fetch(
            `https://api.parallel.ai/v1/tasks/runs/${user.task_run_id}/result`,
            { headers: { "x-api-key": apiKey } },
          );

          if (!resultResponse.ok) {
            const reason = `Result fetch failed: HTTP ${
              resultResponse.status
            } -- ${await resultResponse.text()}`;
            this.sql.exec(
              `UPDATE user_socials SET resolution_status = 'failed', resolved_at = ?, failure_reason = ? WHERE github_username = ?`,
              now,
              reason,
              user.github_username,
            );
            console.log(
              `[SocialsDO] Result fetch failed for ${user.github_username}, marking as failed`,
            );
            return user.github_username;
          }

          const result = (await resultResponse.json()) as ParallelTaskResult;

          if (result.output?.content) {
            const profiles = result.output.content.profiles || [];
            const totalFollowers = profiles.reduce(
              (sum, p) => sum + (p.follower_count || 0),
              0,
            );

            this.sql.exec(
              `UPDATE user_socials SET profiles_json = ?, total_followers = ?, resolved_at = ?, resolution_status = 'completed' WHERE github_username = ?`,
              JSON.stringify(profiles),
              totalFollowers,
              now,
              user.github_username,
            );
            console.log(
              `[SocialsDO] Completed resolution for ${user.github_username}, found ${profiles.length} profiles`,
            );
          } else {
            // Completed but no output - treat as failed
            const reason = `Task completed but no output content`;
            this.sql.exec(
              `UPDATE user_socials SET resolution_status = 'failed', resolved_at = ?, failure_reason = ? WHERE github_username = ?`,
              now,
              reason,
              user.github_username,
            );
            console.log(
              `[SocialsDO] No output for ${user.github_username}, marking as failed`,
            );
          }
        } else {
          // Unknown status - log but don't fail
          console.log(
            `[SocialsDO] Unknown status '${statusResult.status}' for ${user.github_username}`,
          );
        }

        return user.github_username;
      }),
    );

    // Log any errors and mark those users as failed to prevent infinite stuck state
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const user = runningUsers[index];
        console.error(
          `[SocialsDO] Error checking task for ${user.github_username}:`,
          result.reason,
        );
        // Mark as pending to retry later (not failed, as this might be transient)
        this.sql.exec(
          `UPDATE user_socials SET resolution_status = 'pending', task_run_id = NULL, task_started_at = NULL WHERE github_username = ?`,
          user.github_username,
        );
        console.log(
          `[SocialsDO] Reset ${user.github_username} to pending for retry`,
        );
      }
    });
  }

  private async processNewUsers() {
    const apiKey = this.env.PARALLEL_API_KEY;
    if (!apiKey) {
      console.log("[SocialsDO] No PARALLEL_API_KEY configured, skipping");
      return;
    }

    // Get pending users (limit to 100 per run)
    const pendingUsers = this.sql
      .exec(
        `SELECT github_username, github_url FROM user_socials WHERE resolution_status = 'pending' LIMIT 100`,
      )
      .toArray() as { github_username: string; github_url: string }[];

    console.log(`[SocialsDO] Found ${pendingUsers.length} pending users`);

    const results = await Promise.allSettled(
      pendingUsers.map((user) =>
        this.startResolution(user.github_username, user.github_url),
      ),
    );

    // Log any errors
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `[SocialsDO] Error starting resolution for ${pendingUsers[index].github_username}:`,
          result.reason,
        );
      }
    });
  }

  private async startResolution(githubUsername: string, githubUrl: string) {
    const apiKey = this.env.PARALLEL_API_KEY;
    if (!apiKey) return;

    const input = `You are a person entity resolution system. Given a GitHub profile, find and return all digital profiles belonging to this person across various platforms.

Input GitHub Profile:
URL: ${githubUrl}
Username: ${githubUsername}

Instructions:

1. Start by visiting the GitHub profile to gather information about the person (name, bio, website links, social links, email if visible, location, company)
2. Follow any links in their GitHub profile to find connected social accounts
3. Search for and identify profiles across platforms like Twitter/X, LinkedIn, YouTube, Instagram, Facebook, TikTok, personal websites/blogs, dev.to, Medium, Substack, etc.
4. For each profile found:
   - Extract the follower/subscriber count if available
   - Determine if it was self-proclaimed (linked from GitHub or transitively)
   - Determine if it refers back to other found profiles
   - Extract a brief profile snippet
5. Be thorough but conservative - only return profiles you're confident belong to the same person

IMPORTANT: For each profile, try to extract the follower_count as a number. This is critical for ranking.
`;

    const output_json_schema = {
      type: "object",
      required: ["profiles"],
      properties: {
        profiles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              platform_slug: {
                type: "string",
                description:
                  "Platform identifier (e.g., 'twitter', 'linkedin', 'youtube', 'instagram')",
              },
              profile_url: {
                type: "string",
                description: "Full URL to the profile",
              },
              username_on_platform: {
                type: ["string", "null"],
                description: "Username or handle on this platform",
              },
              follower_count: {
                type: ["integer", "null"],
                description:
                  "Number of followers/subscribers on this platform (null if not available)",
              },
              is_self_proclaimed: {
                type: "boolean",
                description:
                  "Whether this profile was discovered through GitHub's chain of references",
              },
              is_self_referring: {
                type: "boolean",
                description:
                  "Whether this profile links back to GitHub or other found profiles",
              },
              match_reasoning: {
                type: "string",
                description:
                  "Explanation of why this profile matches the GitHub user",
              },
              profile_snippet: {
                type: "string",
                description: "Brief excerpt or description from the profile",
              },
            },
            required: [
              "platform_slug",
              "profile_url",
              "is_self_proclaimed",
              "is_self_referring",
              "match_reasoning",
              "profile_snippet",
            ],
          },
        },
      },
    };

    const response = await fetch("https://api.parallel.ai/v1/tasks/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        input,
        processor: "pro",
        task_spec: {
          output_schema: { json_schema: output_json_schema, type: "json" },
        },
      }),
    });

    const result = (await response.json()) as { run_id?: string; error?: any };

    if (result.run_id) {
      const startedAt = Date.now();
      this.sql.exec(
        `UPDATE user_socials SET resolution_status = 'running', task_run_id = ?, task_started_at = ?, failure_reason = NULL WHERE github_username = ?`,
        result.run_id,
        startedAt,
        githubUsername,
      );
      console.log(
        `[SocialsDO] Started resolution for ${githubUsername}, run_id: ${result.run_id}`,
      );
    } else {
      const reason = `Failed to start task: ${
        JSON.stringify(result.error) || "Unknown error"
      }`;
      this.sql.exec(
        `UPDATE user_socials SET resolution_status = 'failed', resolved_at = ?, failure_reason = ? WHERE github_username = ?`,
        Date.now(),
        reason,
        githubUsername,
      );
      console.error(
        `[SocialsDO] Failed to start resolution for ${githubUsername}:`,
        result.error,
      );
    }
  }

  async addUsersFromAnalytics(
    users: { username: string; profile_picture: string | null }[],
  ) {
    const now = Date.now();
    const countBefore =
      (this.sql.exec(`SELECT COUNT(*) as count FROM user_socials`).toArray()[0]
        ?.count as number) || 0;

    for (const user of users) {
      this.sql.exec(
        `INSERT OR IGNORE INTO user_socials (github_username, github_url, created_at) VALUES (?, ?, ?)`,
        user.username,
        `https://github.com/${user.username}`,
        now,
      );
    }

    const countAfter =
      (this.sql.exec(`SELECT COUNT(*) as count FROM user_socials`).toArray()[0]
        ?.count as number) || 0;
    const added = countAfter - countBefore;

    console.log(
      `[SocialsDO] Added ${added} new users from analytics (${users.length} total)`,
    );
    return added;
  }

  async getTopUsersBySocialFollowers(
    limit: number = 50,
  ): Promise<UserSocialData[]> {
    const rows = this.sql
      .exec(
        `SELECT github_username, github_url, profiles_json, total_followers, resolved_at, resolution_status, task_run_id
         FROM user_socials
         WHERE resolution_status = 'completed' AND total_followers > 0
         ORDER BY total_followers DESC
         LIMIT ?`,
        limit,
      )
      .toArray() as {
      github_username: string;
      github_url: string;
      profiles_json: string;
      total_followers: number;
      resolved_at: number;
      resolution_status: string;
      task_run_id: string | null;
    }[];

    return rows.map((row) => ({
      github_username: row.github_username,
      github_url: row.github_url,
      profiles: JSON.parse(row.profiles_json) as SocialProfile[],
      total_followers: row.total_followers,
      resolved_at: row.resolved_at,
      resolution_status:
        row.resolution_status as UserSocialData["resolution_status"],
      task_run_id: row.task_run_id,
    }));
  }

  async getStats() {
    const row = this.sql
      .exec(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN resolution_status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN resolution_status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN resolution_status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN resolution_status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM user_socials`,
      )
      .toArray()[0] as {
      total: number;
      pending: number;
      running: number;
      completed: number;
      failed: number;
    };

    return {
      total: row?.total || 0,
      pending: row?.pending || 0,
      running: row?.running || 0,
      completed: row?.completed || 0,
      failed: row?.failed || 0,
    };
  }

  async getFailedUsers(limit: number = 100): Promise<
    {
      github_username: string;
      github_url: string;
      failure_reason: string | null;
      resolved_at: number | null;
    }[]
  > {
    const rows = this.sql
      .exec(
        `SELECT github_username, github_url, failure_reason, resolved_at
         FROM user_socials
         WHERE resolution_status = 'failed'
         ORDER BY resolved_at DESC
         LIMIT ?`,
        limit,
      )
      .toArray() as {
      github_username: string;
      github_url: string;
      failure_reason: string | null;
      resolved_at: number | null;
    }[];

    return rows;
  }

  async retryFailedUsers(): Promise<{ retried: number }> {
    const result = this.sql.exec(
      `UPDATE user_socials
       SET resolution_status = 'pending', task_run_id = NULL, task_started_at = NULL, failure_reason = NULL
       WHERE resolution_status = 'failed'`,
    );
    const retried = result.rowsWritten;
    console.log(
      `[SocialsDO] Reset ${retried} failed users to pending for retry`,
    );
    return { retried };
  }

  async retrySpecificUsers(usernames: string[]): Promise<{ retried: number }> {
    let retried = 0;
    for (const username of usernames) {
      const result = this.sql.exec(
        `UPDATE user_socials
         SET resolution_status = 'pending', task_run_id = NULL, task_started_at = NULL, failure_reason = NULL
         WHERE github_username = ? AND resolution_status = 'failed'`,
        username,
      );
      retried += result.rowsWritten;
    }
    console.log(
      `[SocialsDO] Reset ${retried} specific failed users to pending`,
    );
    return { retried };
  }

  async triggerManualRun() {
    // Run multiple batches on manual trigger for faster processing
    let totalProcessed = 0;
    for (let i = 0; i < 5; i++) {
      await this.checkRunningTasks();
      await this.processNewUsers();

      // Check how many are still pending
      const pending = this.sql
        .exec(
          `SELECT COUNT(*) as count FROM user_socials WHERE resolution_status = 'pending'`,
        )
        .toArray()[0]?.count as number;

      totalProcessed += 100; // Max per batch
      if (pending === 0) break;
    }

    const stats = await this.getStats();
    return {
      success: true,
      message: `Manual run completed (up to 5 batches)`,
      stats,
    };
  }
}

// ==================== HTML GENERATION ====================

interface FailedUser {
  github_username: string;
  github_url: string;
  failure_reason: string | null;
  resolved_at: number | null;
}

function generateSocialsHTML(
  users: UserSocialData[],
  stats: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  },
  failedUsers: FailedUser[],
): string {
  const platformColors: Record<string, string> = {
    twitter: "#1DA1F2",
    x: "#000000",
    linkedin: "#0A66C2",
    youtube: "#FF0000",
    instagram: "#E4405F",
    facebook: "#1877F2",
    tiktok: "#000000",
    github: "#181717",
    medium: "#000000",
    substack: "#FF6719",
    devto: "#0A0A0A",
    default: "#6B7280",
  };

  const getPlatformColor = (slug: string) =>
    platformColors[slug.toLowerCase()] || platformColors.default;

  const formatFollowers = (count: number) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Top Users by Social Following - uithub</title>
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
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 1px solid #333;
    }
    .header h1 {
      margin: 0 0 10px;
      font-size: 28px;
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .stats-row {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .stat {
      font-size: 14px;
      color: #888;
    }
    .stat strong {
      color: #8b5cf6;
    }
    .user-card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
    }
    .user-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .user-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #333;
    }
    .user-name {
      font-size: 18px;
      font-weight: 600;
    }
    .user-name a {
      color: #f0f0f0;
      text-decoration: none;
    }
    .user-name a:hover {
      color: #8b5cf6;
    }
    .total-followers {
      font-size: 24px;
      font-weight: 700;
      color: #8b5cf6;
    }
    .total-followers-label {
      font-size: 12px;
      color: #888;
      text-transform: uppercase;
    }
    .profiles-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .profile-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #1a1a1a;
      border-radius: 8px;
      text-decoration: none;
      color: #f0f0f0;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .profile-chip:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .platform-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .profile-platform {
      font-weight: 500;
      text-transform: capitalize;
    }
    .profile-followers {
      font-size: 12px;
      color: #888;
      margin-left: 4px;
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #888;
    }
    .trigger-btn {
      background: #8b5cf6;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      margin-left: 16px;
    }
    .trigger-btn:hover {
      background: #7c3aed;
    }
    .trigger-btn.danger {
      background: #dc2626;
    }
    .trigger-btn.danger:hover {
      background: #b91c1c;
    }
    .failed-section {
      margin-top: 40px;
      padding-top: 40px;
      border-top: 1px solid #333;
    }
    .failed-section h2 {
      color: #dc2626;
      margin: 0 0 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .failed-table {
      width: 100%;
      border-collapse: collapse;
      background: #2a2a2a;
      border-radius: 8px;
      overflow: hidden;
    }
    .failed-table th,
    .failed-table td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid #333;
    }
    .failed-table th {
      background: #1a1a1a;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      font-size: 12px;
    }
    .failed-table tr:last-child td {
      border-bottom: none;
    }
    .failed-table a {
      color: #8b5cf6;
      text-decoration: none;
    }
    .failed-table a:hover {
      text-decoration: underline;
    }
    .failure-reason {
      color: #f87171;
      font-size: 13px;
      max-width: 400px;
      word-break: break-word;
    }
    .retry-btn {
      background: #374151;
      color: white;
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .retry-btn:hover {
      background: #4b5563;
    }
    .checkbox-cell {
      width: 30px;
    }
    .select-all-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    @media (max-width: 600px) {
      .user-header {
        flex-direction: column;
        gap: 12px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Top Users by Social Following</h1>
      <div class="stats-row">
        <span class="stat">Total: <strong>${stats.total}</strong></span>
        <span class="stat">Pending: <strong>${stats.pending}</strong></span>
        <span class="stat">Running: <strong>${stats.running}</strong></span>
        <span class="stat">Completed: <strong>${stats.completed}</strong></span>
        <span class="stat">Failed: <strong>${stats.failed}</strong></span>
        <button class="trigger-btn" onclick="syncUsers()">Sync Users</button>
        <button class="trigger-btn" onclick="triggerRun()">Trigger Run</button>
        <button class="trigger-btn" onclick="copyMarkdown()">Copy Markdown</button>
      </div>
    </div>

    ${
      users.length === 0
        ? `<div class="empty-state">
            <h3>No users with social data yet</h3>
            <p>Users will appear here once entity resolution is complete.</p>
          </div>`
        : users
            .map(
              (user, index) => `
      <div class="user-card">
        <div class="user-header">
          <div class="user-info">
            <img src="https://github.com/${
              user.github_username
            }.png?size=96" alt="${
                user.github_username
              }" class="user-avatar" onerror="this.style.display='none'">
            <div>
              <div class="user-name">
                <span style="color:#666;margin-right:8px;">#${index + 1}</span>
                <a href="${user.github_url}" target="_blank">${
                user.github_username
              }</a>
              </div>
            </div>
          </div>
          <div style="text-align:right;">
            <div class="total-followers">${formatFollowers(
              user.total_followers,
            )}</div>
            <div class="total-followers-label">total followers</div>
          </div>
        </div>
        <div class="profiles-grid">
          ${user.profiles
            .sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0))
            .map(
              (p) => `
            <a href="${
              p.profile_url
            }" target="_blank" class="profile-chip" title="${
                p.match_reasoning
              }">
              <span class="platform-dot" style="background:${getPlatformColor(
                p.platform_slug,
              )}"></span>
              <span class="profile-platform">${p.platform_slug}</span>
              ${
                p.follower_count
                  ? `<span class="profile-followers">${formatFollowers(
                      p.follower_count,
                    )}</span>`
                  : ""
              }
            </a>
          `,
            )
            .join("")}
        </div>
      </div>
    `,
            )
            .join("")
    }

    ${
      failedUsers.length > 0
        ? `
    <div class="failed-section">
      <h2>
        <span>❌ Failed Users (${failedUsers.length})</span>
        <button class="trigger-btn danger" onclick="retryAllFailed()">Retry All Failed</button>
        <button class="trigger-btn" onclick="retrySelected()" id="retry-selected-btn" disabled>Retry Selected (0)</button>
      </h2>
      <div class="select-all-row">
        <input type="checkbox" id="select-all" onchange="toggleSelectAll(this)">
        <label for="select-all">Select All</label>
      </div>
      <table class="failed-table">
        <thead>
          <tr>
            <th class="checkbox-cell"></th>
            <th>Username</th>
            <th>Failure Reason</th>
            <th>Failed At</th>
          </tr>
        </thead>
        <tbody>
          ${failedUsers
            .map(
              (u) => `
          <tr>
            <td class="checkbox-cell">
              <input type="checkbox" class="user-checkbox" data-username="${
                u.github_username
              }" onchange="updateSelectedCount()">
            </td>
            <td><a href="${u.github_url}" target="_blank">${
                u.github_username
              }</a></td>
            <td class="failure-reason">${
              u.failure_reason || "Unknown reason"
            }</td>
            <td>${
              u.resolved_at ? new Date(u.resolved_at).toLocaleString() : "-"
            }</td>
          </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }
  </div>
  <script>
    const usersData = ${JSON.stringify(
      users.map((u) => ({
        github_username: u.github_username,
        github_url: u.github_url,
        total_followers: u.total_followers,
        profiles: u.profiles.map((p) => ({
          platform_slug: p.platform_slug,
          profile_url: p.profile_url,
          username_on_platform: p.username_on_platform,
          follower_count: p.follower_count,
          profile_snippet: p.profile_snippet,
        })),
      })),
    )};

    function formatFollowersJS(count) {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return count.toString();
    }

    function copyMarkdown() {
      const filtered = usersData.filter(u => u.total_followers >= 500);
      if (filtered.length === 0) {
        alert('No users with 500+ followers found.');
        return;
      }

      let md = '# Top Users by Social Following (500+ followers)\\n\\n';

      filtered.forEach((user, index) => {
        md += '## ' + (index + 1) + '. [' + user.github_username + '](' + user.github_url + ') (' + formatFollowersJS(user.total_followers) + ' total followers)\\n\\n';

        const sortedProfiles = [...user.profiles].sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0));

        sortedProfiles.forEach(p => {
          const followerStr = p.follower_count ? ' - ' + formatFollowersJS(p.follower_count) + ' followers' : '';
          const usernameStr = p.username_on_platform ? ' (@' + p.username_on_platform + ')' : '';
          md += '- **' + p.platform_slug.charAt(0).toUpperCase() + p.platform_slug.slice(1) + '**' + usernameStr + followerStr + '\\n';
          md += '  - [' + p.profile_url + '](' + p.profile_url + ')\\n';
          if (p.profile_snippet) {
            md += '  > ' + p.profile_snippet.replace(/\\n/g, ' ').trim() + '\\n';
          }
          md += '\\n';
        });

        md += '---\\n\\n';
      });

      navigator.clipboard.writeText(md).then(() => {
        alert('Copied markdown for ' + filtered.length + ' users with 500+ followers!');
      }).catch(err => {
        alert('Failed to copy: ' + err.message);
      });
    }

    async function syncUsers() {
      try {
        const res = await fetch('/socials?sync=1');
        const data = await res.json();
        alert(data.message + ' - Added: ' + data.added + ', Total from analytics: ' + data.total_from_analytics);
        location.reload();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }
    async function triggerRun() {
      try {
        const res = await fetch('/socials?trigger=1', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'Triggered!');
        location.reload();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    function toggleSelectAll(checkbox) {
      const checkboxes = document.querySelectorAll('.user-checkbox');
      checkboxes.forEach(cb => cb.checked = checkbox.checked);
      updateSelectedCount();
    }

    function updateSelectedCount() {
      const checkboxes = document.querySelectorAll('.user-checkbox:checked');
      const btn = document.getElementById('retry-selected-btn');
      if (btn) {
        btn.textContent = 'Retry Selected (' + checkboxes.length + ')';
        btn.disabled = checkboxes.length === 0;
      }
      // Update select-all state
      const allCheckboxes = document.querySelectorAll('.user-checkbox');
      const selectAll = document.getElementById('select-all');
      if (selectAll && allCheckboxes.length > 0) {
        selectAll.checked = checkboxes.length === allCheckboxes.length;
        selectAll.indeterminate = checkboxes.length > 0 && checkboxes.length < allCheckboxes.length;
      }
    }

    async function retryAllFailed() {
      if (!confirm('Retry all failed users?')) return;
      try {
        const res = await fetch('/socials?retry-failed=1', { method: 'POST' });
        const data = await res.json();
        alert(data.message);
        location.reload();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function retrySelected() {
      const checkboxes = document.querySelectorAll('.user-checkbox:checked');
      const usernames = Array.from(checkboxes).map(cb => cb.dataset.username);
      if (usernames.length === 0) {
        alert('No users selected');
        return;
      }
      if (!confirm('Retry ' + usernames.length + ' selected users?')) return;
      try {
        const res = await fetch('/socials?retry-users=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames })
        });
        const data = await res.json();
        alert(data.message);
        location.reload();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }
  </script>
</body>
</html>`;
}

// ==================== HANDLER ====================

export async function handleSocials(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const id = env.SOCIALS_DO.idFromName("global");
  const stub = env.SOCIALS_DO.get(id);

  // Ensure alarm is set
  await stub.ensureAlarmSet();

  // Handle manual trigger
  if (request.method === "POST" && url.searchParams.get("trigger")) {
    const result = await stub.triggerManualRun();
    return Response.json(result);
  }

  // Handle retry all failed
  if (request.method === "POST" && url.searchParams.get("retry-failed")) {
    const result = await stub.retryFailedUsers();
    return Response.json({
      message: `Reset ${result.retried} failed users to pending`,
      ...result,
    });
  }

  // Handle retry specific users
  if (request.method === "POST" && url.searchParams.get("retry-users")) {
    const body = (await request.json()) as { usernames: string[] };
    const result = await stub.retrySpecificUsers(body.usernames || []);
    return Response.json({
      message: `Reset ${result.retried} users to pending`,
      ...result,
    });
  }

  // Sync users from analytics
  if (url.searchParams.get("sync")) {
    const analyticsId = env.ANALYTICS_DO.idFromName("global2");
    const analyticsStub = env.ANALYTICS_DO.get(analyticsId);
    const allUsers = await analyticsStub.getAllUsers();

    const added = await stub.addUsersFromAnalytics(allUsers);
    return Response.json({
      message: `Synced users from analytics`,
      added,
      total_from_analytics: allUsers.length,
    });
  }

  const [users, stats, failedUsers] = await Promise.all([
    stub.getTopUsersBySocialFollowers(200),
    stub.getStats(),
    stub.getFailedUsers(100),
  ]);

  const accept = request.headers.get("Accept") || "";
  if (accept.includes("application/json")) {
    return Response.json({ users, stats, failedUsers });
  }

  return new Response(generateSocialsHTML(users, stats, failedUsers), {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache",
    },
  });
}
