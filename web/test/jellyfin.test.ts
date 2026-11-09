// Which login the page uses, what it sends with it, and the sign-in calls, against a plain map and a fake fetch.
import { expect, test } from "vitest";
import {
  authHeader, forgetPageLogin, HttpError, Jellyfin, type KeyValueStore, loginsFor, pageLogin, savedLogins,
  savePageLogin, webClientLogin,
} from "../src/jellyfin.js";

const SERVER = "5f1b9c0e6a6d4e8b9a4c3b2a1f0e9d8c";

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The web client's saved logins, as jellyfin-apiclient's Credentials class writes them. */
const webCredentials = (servers: object[]) => ({ jellyfin_credentials: JSON.stringify({ Servers: servers }) });

test("the web client's login is found by server id, in any case", () => {
  const store = memoryStore(webCredentials([
    { Id: "another-server", AccessToken: "other", UserId: "u0" },
    { Id: SERVER.toUpperCase(), AccessToken: "tok", UserId: "u1", ManualAddress: "http://x" },
  ]));
  expect(webClientLogin(store, SERVER)).toEqual({ token: "tok", userId: "u1", source: "web" });
});

test("a web client entry with no token (signed out there), no entry, or bad JSON gives no login", () => {
  expect(webClientLogin(memoryStore(webCredentials([{ Id: SERVER, AccessToken: null, UserId: null }])), SERVER)).toBeNull();
  expect(webClientLogin(memoryStore(webCredentials([{ Id: "another-server", AccessToken: "t", UserId: "u" }])), SERVER)).toBeNull();
  expect(webClientLogin(memoryStore({ jellyfin_credentials: "{not json" }), SERVER)).toBeNull();
  expect(webClientLogin(memoryStore({ jellyfin_credentials: '{"Servers": 3}' }), SERVER)).toBeNull();
  expect(webClientLogin(memoryStore(), SERVER)).toBeNull();
});

test("the page's own login is kept per server and tried before the web client's", () => {
  const store = memoryStore(webCredentials([{ Id: SERVER, AccessToken: "web", UserId: "u1" }]));
  expect(savedLogins(store, SERVER).map((l) => l.source)).toEqual(["web"]);

  savePageLogin(store, SERVER.toUpperCase(), "mine", "u2");
  savePageLogin(store, "another-server", "theirs", "u3");
  expect(savedLogins(store, SERVER)).toEqual([
    { token: "mine", userId: "u2", source: "page" },
    { token: "web", userId: "u1", source: "web" },
  ]);

  forgetPageLogin(store, SERVER);
  expect(pageLogin(store, SERVER)).toBeNull();
  expect(pageLogin(store, "another-server")?.token).toBe("theirs");
  forgetPageLogin(store, "another-server");
  expect(store.data.has("discmenu.logins")).toBe(false);
  expect(store.data.get("jellyfin_credentials")).toContain('"web"'); // the web client's own login is never touched
});

test("a reused web client token goes alone, so the server keeps the web client's device name", () => {
  expect(authHeader("dev1", { token: "web", userId: "u", source: "web" })).toBe('MediaBrowser Token="web"');
  expect(authHeader("dev1", { token: "mine", userId: "u", source: "page" })).toBe(
    'MediaBrowser Client="Disc Menu", Device="Browser", DeviceId="dev1", Version="test", Token="mine"',
  );
  expect(authHeader("dev1", null)).toBe('MediaBrowser Client="Disc Menu", Device="Browser", DeviceId="dev1", Version="test"');
});

interface Sent {
  url: string;
  method: string;
  auth: string;
  type?: string;
  body?: unknown;
}

function fakeServer(answers: Record<string, { status?: number; json?: unknown }>) {
  const sent: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url, method: init?.method ?? "GET", auth: headers.Authorization, type: headers["Content-Type"],
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = url.replace("http://jf/base/", "").split("?")[0];
    const a = answers[path] ?? { status: 404 };
    const status = a.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(a.json ?? null), { status, statusText: "x" });
  }) as typeof fetch;
  return { sent, fetcher };
}

test("signing in posts the user name and password, naming the page and its device", async () => {
  const { sent, fetcher } = fakeServer({
    "Users/AuthenticateByName": { json: { AccessToken: "t1", User: { Id: "u1", Name: "admin" } } },
  });
  const store = memoryStore({ "discmenu.deviceId": "dev1" });
  const jf = new Jellyfin("http://jf/base", null, store, fetcher);

  expect(await jf.signIn("admin", "pw")).toEqual({ token: "t1", userId: "u1", name: "admin" });
  expect(sent[0]).toEqual({
    url: "http://jf/base/Users/AuthenticateByName", method: "POST", type: "application/json",
    auth: 'MediaBrowser Client="Disc Menu", Device="Browser", DeviceId="dev1", Version="test"',
    body: { Username: "admin", Pw: "pw" },
  });
});

test("a wrong password is an HttpError with the server's status", async () => {
  const { fetcher } = fakeServer({ "Users/AuthenticateByName": { status: 401 } });
  const err = await new Jellyfin("http://jf/base/", null, memoryStore(), fetcher).signIn("admin", "no").catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(401);
});

test("Quick Connect: start, check, finish; off or unreachable reads as off", async () => {
  const { sent, fetcher } = fakeServer({
    "QuickConnect/Enabled": { json: true },
    "QuickConnect/Initiate": { json: { Secret: "s e/c", Code: "123456", Authenticated: false } },
    "QuickConnect/Connect": { json: { Secret: "s e/c", Code: "123456", Authenticated: true } },
    "Users/AuthenticateWithQuickConnect": { json: { AccessToken: "t2", User: { Id: "u2", Name: "viewer" } } },
  });
  const jf = new Jellyfin("http://jf/base/", null, memoryStore(), fetcher);
  expect(await jf.quickConnectEnabled()).toBe(true);
  const req = await jf.quickConnectStart();
  expect(req.Code).toBe("123456");
  expect((await jf.quickConnectState(req.Secret)).Authenticated).toBe(true);
  expect(await jf.quickConnectFinish(req.Secret)).toEqual({ token: "t2", userId: "u2", name: "viewer" });
  expect(sent.map((s) => `${s.method} ${s.url.replace("http://jf/base/", "")}`)).toEqual([
    "GET QuickConnect/Enabled",
    "POST QuickConnect/Initiate",
    "GET QuickConnect/Connect?secret=s%20e%2Fc",
    "POST Users/AuthenticateWithQuickConnect",
  ]);
  expect(sent[1].auth).toContain('Client="Disc Menu"'); // Initiate needs the client and device named
  expect(sent[3].body).toEqual({ Secret: "s e/c" });

  const off = fakeServer({ "QuickConnect/Enabled": { json: false } });
  expect(await new Jellyfin("http://jf/base/", null, memoryStore(), off.fetcher).quickConnectEnabled()).toBe(false);
  const missing = fakeServer({});
  expect(await new Jellyfin("http://jf/base/", null, memoryStore(), missing.fetcher).quickConnectEnabled()).toBe(false);
});

test("signing out ends only the page's own login", async () => {
  const { sent, fetcher } = fakeServer({ "Sessions/Logout": { status: 204 } });
  const store = memoryStore();
  await new Jellyfin("http://jf/base/", { token: "web", userId: "u", source: "web" }, store, fetcher).signOut();
  expect(sent).toEqual([]);
  await new Jellyfin("http://jf/base/", { token: "mine", userId: "u", source: "page" }, store, fetcher).signOut();
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST http://jf/base/Sessions/Logout"]);
  expect(sent[0].auth).toContain('Token="mine"');
});

test("pack images, videos and audio carry the login's token in ApiKey=", () => {
  const store = memoryStore({ "discmenu.deviceId": "dev1" });
  const web = new Jellyfin("http://jf/base/", { token: "web tok", userId: "u", source: "web" }, store);
  expect(web.withKey("http://jf/base/a.png")).toBe("http://jf/base/a.png?ApiKey=web%20tok");
  expect(web.withKey("http://jf/base/a.png?x=1")).toBe("http://jf/base/a.png?x=1&ApiKey=web%20tok");

  const none = new Jellyfin("http://jf/base/", null, store);
  expect(none.withKey("http://jf/base/a.png")).toBe("http://jf/base/a.png");
});

test("the device id is made once and kept", () => {
  const store = memoryStore();
  const a = new Jellyfin("http://jf/", null, store).deviceId;
  expect(a).toMatch(/^disc-menu-/);
  expect(new Jellyfin("http://jf/", null, store).deviceId).toBe(a);
});

test("inside the overlay, only the web client's login is used", () => {
  const store = memoryStore(webCredentials([{ Id: SERVER, AccessToken: "web", UserId: "u1" }]));
  savePageLogin(store, SERVER, "mine", "u2");
  const all = savedLogins(store, SERVER);
  expect(loginsFor(false, all).map((l) => l.source)).toEqual(["page", "web"]);
  expect(loginsFor(true, all)).toEqual([{ token: "web", userId: "u1", source: "web" }]);
  expect(loginsFor(true, [{ token: "mine", userId: "u2", source: "page" }])).toEqual([]);
});
