import { DurableObject } from "cloudflare:workers";
import { type Env, getUser } from "./auth";

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
}

interface AnalyticsStats {
  total_requests: number;
  unique_users: number;
  api_requests: number;
  browser_requests: number;
  top_repos: { repo: string; count: number }[];
  top_users: { username: string; profile_picture: string | null; count: number }[];
  requests_by_hour: { hour: string; count: number }[];
  requests_by_day: { day: string; count: number }[];
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
  }

  async log(data: Omit<AnalyticsDatapoint, "id" | "timestamp">) {
    this.sql.exec(
      `INSERT INTO analytics (timestamp, username, profile_picture, owner, repo, page, path, user_agent, accept, is_api)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      data.username,
      data.profile_picture,
      data.owner,
      data.repo,
      data.page,
      data.path,
      data.user_agent,
      data.accept,
      data.is_api ? 1 : 0
    );
  }

  async getStats(days: number = 7): Promise<AnalyticsStats> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const totalRequests = this.sql
      .exec(`SELECT COUNT(*) as count FROM analytics WHERE timestamp > ?`, since)
      .toArray()[0]?.count as number || 0;

    const uniqueUsers = this.sql
      .exec(`SELECT COUNT(DISTINCT username) as count FROM analytics WHERE timestamp > ? AND username IS NOT NULL`, since)
      .toArray()[0]?.count as number || 0;

    const apiRequests = this.sql
      .exec(`SELECT COUNT(*) as count FROM analytics WHERE timestamp > ? AND is_api = 1`, since)
      .toArray()[0]?.count as number || 0;

    const browserRequests = this.sql
      .exec(`SELECT COUNT(*) as count FROM analytics WHERE timestamp > ? AND is_api = 0`, since)
      .toArray()[0]?.count as number || 0;

    const topRepos = this.sql
      .exec(
        `SELECT owner || '/' || repo as repo, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY owner, repo ORDER BY count DESC LIMIT 10`,
        since
      )
      .toArray() as { repo: string; count: number }[];

    const topUsers = this.sql
      .exec(
        `SELECT username, profile_picture, COUNT(*) as count
         FROM analytics WHERE timestamp > ? AND username IS NOT NULL
         GROUP BY username ORDER BY count DESC LIMIT 10`,
        since
      )
      .toArray() as { username: string; profile_picture: string | null; count: number }[];

    // Requests by hour (last 24 hours)
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    const requestsByHour = this.sql
      .exec(
        `SELECT strftime('%H', timestamp/1000, 'unixepoch') as hour, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY hour ORDER BY hour`,
        last24h
      )
      .toArray() as { hour: string; count: number }[];

    // Requests by day (last N days)
    const requestsByDay = this.sql
      .exec(
        `SELECT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch') as day, COUNT(*) as count
         FROM analytics WHERE timestamp > ?
         GROUP BY day ORDER BY day`,
        since
      )
      .toArray() as { day: string; count: number }[];

    return {
      total_requests: totalRequests,
      unique_users: uniqueUsers,
      api_requests: apiRequests,
      browser_requests: browserRequests,
      top_repos: topRepos,
      top_users: topUsers,
      requests_by_hour: requestsByHour,
      requests_by_day: requestsByDay,
    };
  }

  async getRecentRequests(limit: number = 100): Promise<AnalyticsDatapoint[]> {
    return this.sql
      .exec(
        `SELECT id, timestamp, username, profile_picture, owner, repo, page, path, user_agent, accept, is_api
         FROM analytics ORDER BY timestamp DESC LIMIT ?`,
        limit
      )
      .toArray() as AnalyticsDatapoint[];
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
  }
) {
  const { currentUser } = await getUser(request, env);

  // Skip logging for unauthenticated requests
  if (!currentUser) {
    return;
  }

  const accept = request.headers.get("Accept") || "";
  const userAgent = request.headers.get("User-Agent") || "";
  const isApi = !accept.includes("text/html") || userAgent.includes("curl") || userAgent.includes("httpie");

  const id = env.ANALYTICS_DO.idFromName("global");
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
    .empty-state {
      text-align: center;
      padding: 40px;
      opacity: 0.5;
    }
    @media (max-width: 600px) {
      .charts-grid, .lists-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Analytics Dashboard</h1>
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

    <div class="charts-grid">
      <div class="chart-card">
        <h3>Requests by Hour (Last 24h)</h3>
        <div class="chart-container">
          <canvas id="hourlyChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>Requests by Day (Last 7 Days)</h3>
        <div class="chart-container">
          <canvas id="dailyChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>Request Types</h3>
        <div class="chart-container">
          <canvas id="typeChart"></canvas>
        </div>
      </div>
    </div>

    <div class="lists-grid">
      <div class="list-card">
        <h3>Top Repositories</h3>
        ${stats.top_repos.length === 0
          ? '<div class="empty-state">No data yet</div>'
          : stats.top_repos.map(repo => `
            <div class="list-item">
              <div class="list-item-left">
                <span class="list-item-name">${repo.repo}</span>
              </div>
              <span class="list-item-count">${repo.count.toLocaleString()}</span>
            </div>
          `).join('')
        }
      </div>
      <div class="list-card">
        <h3>Top Users</h3>
        ${stats.top_users.length === 0
          ? '<div class="empty-state">No data yet</div>'
          : stats.top_users.map(user => `
            <div class="list-item">
              <div class="list-item-left">
                ${user.profile_picture
                  ? `<img src="${user.profile_picture}" alt="${user.username}" class="user-avatar">`
                  : ''
                }
                <span class="list-item-name">${user.username}</span>
              </div>
              <span class="list-item-count">${user.count.toLocaleString()}</span>
            </div>
          `).join('')
        }
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
  </script>
</body>
</html>`;
}

// ==================== HANDLER ====================

export async function handleAnalytics(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "7");

  const id = env.ANALYTICS_DO.idFromName("global");
  const stub = env.ANALYTICS_DO.get(id);
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
