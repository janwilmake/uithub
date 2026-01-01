import { type Env, getUser, getUserAccount } from "./auth";

interface ApiKey {
  id: string;
  name: string;
  key: string;
  created_at: number;
  last_used?: number;
}

interface ClientAccess {
  client_id: string;
  client_name: string;
  created_at: number;
  last_used?: number;
  scopes: string;
}

// ==================== KV HELPERS ====================

async function getUserApiKeys(userId: string, env: Env): Promise<ApiKey[]> {
  const data = await env.KV.get(`user_api_keys_${userId}`, "json");
  return (data as ApiKey[]) || [];
}

async function setUserApiKeys(
  userId: string,
  apiKeys: ApiKey[],
  env: Env,
): Promise<void> {
  await env.KV.put(`user_api_keys_${userId}`, JSON.stringify(apiKeys));
}

async function getUserClientAccess(
  userId: string,
  env: Env,
): Promise<ClientAccess[]> {
  const data = await env.KV.get(`user_client_access_${userId}`, "json");
  return (data as ClientAccess[]) || [];
}

async function setUserClientAccess(
  userId: string,
  clientAccess: ClientAccess[],
  env: Env,
): Promise<void> {
  await env.KV.put(
    `user_client_access_${userId}`,
    JSON.stringify(clientAccess),
  );
}

// ==================== API KEY MANAGEMENT ====================

function generateApiKey(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return (
    "uitk_" + Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

async function createApiKey(
  userId: string,
  name: string,
  env: Env,
): Promise<ApiKey> {
  const apiKeys = await getUserApiKeys(userId, env);
  const newKey: ApiKey = {
    id: crypto.randomUUID(),
    name,
    key: generateApiKey(),
    created_at: Date.now(),
  };
  apiKeys.push(newKey);
  await setUserApiKeys(userId, apiKeys, env);
  return newKey;
}

async function deleteApiKey(
  userId: string,
  keyId: string,
  env: Env,
): Promise<boolean> {
  const apiKeys = await getUserApiKeys(userId, env);
  const filtered = apiKeys.filter((k) => k.id !== keyId);
  if (filtered.length === apiKeys.length) return false;
  await setUserApiKeys(userId, filtered, env);
  return true;
}

async function revokeClientAccess(
  userId: string,
  clientId: string,
  env: Env,
): Promise<boolean> {
  const clientAccess = await getUserClientAccess(userId, env);
  const filtered = clientAccess.filter((c) => c.client_id !== clientId);
  if (filtered.length === clientAccess.length) return false;
  await setUserClientAccess(userId, filtered, env);
  return true;
}

// ==================== HTML GENERATION ====================

function generateDashboardHTML(context: {
  username: string;
  profilePicture: string;
  credit: number;
  apiKeys: ApiKey[];
  clientAccess: ClientAccess[];
  paymentLink: string;
  logoutUrl: string;
}): string {
  const {
    username,
    profilePicture,
    credit,
    apiKeys,
    clientAccess,
    paymentLink,
    logoutUrl,
  } = context;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - uithub</title>
  <style>
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 1px solid #333;
    }
    .user-info {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .avatar {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      border: 3px solid #8b5cf6;
    }
    .user-details h1 {
      margin: 0;
      font-size: 24px;
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .user-details p {
      margin: 4px 0 0;
      opacity: 0.7;
    }
    .logout-btn {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      transition: all 0.2s;
    }
    .logout-btn:hover {
      background: rgba(239, 68, 68, 0.2);
    }
    .section {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .section h2 {
      margin: 0 0 20px;
      font-size: 20px;
      color: #8b5cf6;
    }
    .credit-display {
      font-size: 48px;
      font-weight: 700;
      color: ${credit >= 100 ? "#22c55e" : "#ef4444"};
      margin-bottom: 16px;
    }
    .add-credit-btn {
      background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      transition: all 0.2s;
    }
    .add-credit-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(139, 92, 246, 0.4);
    }
    .api-key-list, .client-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .api-key-item, .client-item {
      background: #1a1a1a;
      padding: 16px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .api-key-info, .client-info {
      flex: 1;
    }
    .api-key-name, .client-name {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .api-key-value {
      font-family: monospace;
      font-size: 14px;
      opacity: 0.7;
      word-break: break-all;
    }
    .api-key-meta, .client-meta {
      font-size: 12px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .delete-btn, .revoke-btn {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }
    .delete-btn:hover, .revoke-btn:hover {
      background: rgba(239, 68, 68, 0.2);
    }
    .create-key-form {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }
    .create-key-input {
      flex: 1;
      background: #1a1a1a;
      border: 1px solid #444;
      color: #f0f0f0;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
    }
    .create-key-btn {
      background: #8b5cf6;
      color: white;
      border: none;
      padding: 10px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    }
    .create-key-btn:hover {
      background: #7c3aed;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="user-info">
        <img src="${profilePicture}" alt="${username}" class="avatar">
        <div class="user-details">
          <h1>@${username}</h1>
          <p>Dashboard</p>
        </div>
      </div>
      <a href="${logoutUrl}" class="logout-btn">Logout</a>
    </div>

    <div class="section">
      <h2>💳 Balance</h2>
      <div class="credit-display">$${(credit / 100).toFixed(2)}</div>
      <a href="${paymentLink}" target="_blank" class="add-credit-btn">Add Credit</a>
      <p style="margin-top: 12px; opacity: 0.7; font-size: 14px;">
        Private repository access costs $0.01 per request
      </p>
    </div>

    <div class="section">
      <h2>🔑 API Keys</h2>
      <form class="create-key-form" method="POST" action="/dashboard/api-keys/create">
        <input 
          type="text" 
          name="name" 
          class="create-key-input" 
          placeholder="API Key Name (e.g., Production Key)" 
          required
        >
        <button type="submit" class="create-key-btn">Create New Key</button>
      </form>
      <div class="api-key-list">
        ${
          apiKeys.length === 0
            ? '<div class="empty-state">No API keys yet. Create one to get started.</div>'
            : apiKeys
                .map(
                  (key) => `
          <div class="api-key-item">
            <div class="api-key-info">
              <div class="api-key-name">${key.name}</div>
              <div class="api-key-value">${key.key}</div>
              <div class="api-key-meta">
                Created: ${new Date(key.created_at).toLocaleDateString()}
                ${
                  key.last_used
                    ? ` • Last used: ${new Date(
                        key.last_used,
                      ).toLocaleDateString()}`
                    : ""
                }
              </div>
            </div>
            <form method="POST" action="/dashboard/api-keys/delete" style="margin: 0;">
              <input type="hidden" name="key_id" value="${key.id}">
              <button type="submit" class="delete-btn">Delete</button>
            </form>
          </div>
        `,
                )
                .join("")
        }
      </div>
    </div>

    <div class="section">
      <h2>🔐 OAuth Client Access</h2>
      <div class="client-list">
        ${
          clientAccess.length === 0
            ? '<div class="empty-state">No OAuth clients have been authorized yet.</div>'
            : clientAccess
                .map(
                  (client) => `
          <div class="client-item">
            <div class="client-info">
              <div class="client-name">${client.client_name}</div>
              <div class="client-meta">
                Client ID: ${client.client_id}<br>
                Scopes: ${client.scopes}<br>
                Authorized: ${new Date(client.created_at).toLocaleDateString()}
                ${
                  client.last_used
                    ? ` • Last used: ${new Date(
                        client.last_used,
                      ).toLocaleDateString()}`
                    : ""
                }
              </div>
            </div>
            <form method="POST" action="/dashboard/clients/revoke" style="margin: 0;">
              <input type="hidden" name="client_id" value="${client.client_id}">
              <button type="submit" class="revoke-btn">Revoke Access</button>
            </form>
          </div>
        `,
                )
                .join("")
        }
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ==================== MAIN HANDLER ====================

export async function handleDashboard(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const { currentUser } = await getUser(request, env);

  if (!currentUser) {
    const loginUrl = `${url.origin}/login?scope=user:email&redirect_to=/dashboard`;
    return Response.redirect(loginUrl, 302);
  }

  const userId = String(currentUser.id);

  // Handle POST requests for creating/deleting keys and revoking access
  if (request.method === "POST") {
    if (url.pathname === "/dashboard/api-keys/create") {
      const formData = await request.formData();
      const name = formData.get("name")?.toString() || "Unnamed Key";
      await createApiKey(userId, name, env);
      return Response.redirect("/dashboard", 303);
    }

    if (url.pathname === "/dashboard/api-keys/delete") {
      const formData = await request.formData();
      const keyId = formData.get("key_id")?.toString();
      if (keyId) {
        await deleteApiKey(userId, keyId, env);
      }
      return Response.redirect("/dashboard", 303);
    }

    if (url.pathname === "/dashboard/clients/revoke") {
      const formData = await request.formData();
      const clientId = formData.get("client_id")?.toString();
      if (clientId) {
        await revokeClientAccess(userId, clientId, env);
      }
      return Response.redirect("/dashboard", 303);
    }
  }

  // GET request - show dashboard
  const userAccount = await getUserAccount(userId, env);
  const apiKeys = await getUserApiKeys(userId, env);
  const clientAccess = await getUserClientAccess(userId, env);

  const html = generateDashboardHTML({
    username: currentUser.login,
    profilePicture: currentUser.avatar_url,
    credit: userAccount?.credit || 0,
    apiKeys,
    clientAccess,
    paymentLink: `${env.STRIPE_PAYMENT_LINK}?client_reference_id=${userId}`,
    logoutUrl: "/logout?redirect_to=/",
  });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "X-XSS-Protection": "1; mode=block",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
