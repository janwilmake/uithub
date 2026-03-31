import { describe, it } from "node:test";
import assert from "node:assert";
import { getSessionFromCookie } from "./auth.ts";

// Simulate encoding a session the OLD way (plain btoa, Latin1 only)
function encodeSessionOld(data: object): string {
  return btoa(JSON.stringify(data));
}

// Simulate encoding a session the NEW way (UTF-8 safe)
function encodeSessionNew(data: object): string {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data)))
  );
}

function makeRequest(sessionToken: string): Request {
  return new Request("https://example.com", {
    headers: { Cookie: `session=${sessionToken}` },
  });
}

const validSession = {
  user: { login: "testuser", name: "Test User" },
  accessToken: "ghs_abc123",
  scopes: "repo",
  exp: Date.now() + 3600 * 1000,
};

describe("getSessionFromCookie", () => {
  it("reads a session encoded with the old btoa method (backward compat)", () => {
    const token = encodeSessionOld(validSession);
    const result = getSessionFromCookie(makeRequest(token));
    assert.strictEqual(result.accessToken, "ghs_abc123");
    assert.strictEqual(result.user.login, "testuser");
    assert.strictEqual(result.scopes, "repo");
  });

  it("reads a session encoded with the new UTF-8 safe method", () => {
    const token = encodeSessionNew(validSession);
    const result = getSessionFromCookie(makeRequest(token));
    assert.strictEqual(result.accessToken, "ghs_abc123");
    assert.strictEqual(result.user.login, "testuser");
  });

  it("reads a session with Unicode characters in user data", () => {
    const unicodeSession = {
      ...validSession,
      user: { login: "user", name: "王小明" },
    };
    const token = encodeSessionNew(unicodeSession);
    const result = getSessionFromCookie(makeRequest(token));
    assert.strictEqual(result.user.name, "王小明");
  });

  it("returns null for an expired session", () => {
    const expired = { ...validSession, exp: Date.now() - 1000 };
    const token = encodeSessionNew(expired);
    const result = getSessionFromCookie(makeRequest(token));
    assert.strictEqual(result.accessToken, null);
    assert.strictEqual(result.user, null);
  });

  it("fails to encode Unicode with the old btoa method (documents the bug)", () => {
    const unicodeSession = {
      ...validSession,
      user: { login: "user", name: "王小明" },
    };
    assert.throws(() => encodeSessionOld(unicodeSession), /Invalid character/);
  });

  it("returns null when no session cookie is present", () => {
    const result = getSessionFromCookie(new Request("https://example.com"));
    assert.strictEqual(result.accessToken, null);
    assert.strictEqual(result.user, null);
  });
});
