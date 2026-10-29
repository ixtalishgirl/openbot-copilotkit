/**
 * Where a Bot's traffic leaves from.
 *
 * Per-Bot egress identity makes traffic attributable to the Bot that caused it. With a distinct
 * upstream proxy per Bot, the far side sees a different address for each Bot and can enforce network
 * rules alongside application policy.
 *
 * This does not anonymise anything and it is not a security boundary by itself. It
 * gives the far side a stable, per-Bot address to allow-list or attribute, which is what a security
 * team actually asks for. A Bot with no proxy configured goes out directly, which is the right default
 * for a laptop and the wrong one for a deployment that cares.
 *
 * This module has no Playwright import, so proxy parsing tests can run outside the browser image.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";

/** A proxy as Playwright wants it: credentials separated from the URL. */
export type Egress = {
  server: string;
  username?: string;
  password?: string;
};

/**
 * The environment variable naming a Bot's proxy.
 *
 * Upper-cased with anything unusual replaced, because a bot id is a free-form string and an
 * environment variable name is not. `sales-bot` reads `EGRESS_PROXY_SALES_BOT`.
 */
export function egressVariableFor(botId: string): string {
  return `EGRESS_PROXY_${botId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

/**
 * Resolve a Bot's proxy from the environment, or null for direct.
 *
 * `EGRESS_PROXY_<BOT>` names one Bot's proxy; `EGRESS_PROXY_DEFAULT` covers the rest.
 */
export function egressFor(
  botId: string,
  env: Record<string, string | undefined>,
): Egress | null {
  /*
   * While the network-policy filter runs, every Bot's browser goes through it, and it carries the
   * Bot in the proxy credentials so one filter can hold a policy per Bot. The filter chains to the
   * configured upstream itself, so the per-Bot address the far side sees is unchanged. A browser is
   * pointed at the filter's browser listener, which asks for those credentials (see
   * `startEgressFilter`), so every connection it makes says whose browser it is.
   */
  if (filter) {
    return {
      server: `http://127.0.0.1:${filter.browserPort}`,
      username: botId,
      password: filter.secret,
    };
  }
  return upstreamFor(botId, env);
}

/** The configured upstream proxy for a Bot, ignoring the filter. */
export function upstreamFor(
  botId: string,
  env: Record<string, string | undefined>,
): Egress | null {
  const raw = env[egressVariableFor(botId)] ?? env.EGRESS_PROXY_DEFAULT;
  if (!raw?.trim()) return null;
  return splitProxyCredentials(raw);
}

/**
 * Split a proxy string into a server and its credentials.
 *
 * Credentials commonly arrive inside the URL, which is how proxies are handed out. They are split out
 * so that the server string can be shown to a person without leaking a password.
 *
 * Two shapes reach here, and only one of them is a URL as far as the parser is concerned. A bare
 * `host:port` is what an operator writes when they are not thinking about URLs, and Playwright and
 * curl both take it; `new URL` reads `proxy.internal:8080` as the scheme `proxy.internal:` and the
 * path `8080` with an empty host, rather than throwing. `username` and `password` come back empty for
 * that shape, so a proxy written `bot:s3cret@proxy.internal:8080` would keep its password in the
 * string it hands back. Re-parsing behind a synthetic scheme makes the split happen for both shapes;
 * the synthetic scheme is then removed so the server reads the way it was written.
 */
export function splitProxyCredentials(raw: string): Egress {
  const trimmed = raw.trim();

  let url: URL | null = null;
  let synthetic = "";
  try {
    const asWritten = new URL(trimmed);
    if (asWritten.host !== "") url = asWritten;
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
  if (!url) {
    synthetic = "http://";
    try {
      url = new URL(`${synthetic}${trimmed}`);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      // Not addressable either way. Passed through, so an operator who writes the obvious thing is
      // not told they are wrong.
      return { server: trimmed };
    }
  }

  const username = url.username ? decodeUserinfo(url.username) : undefined;
  const password = url.password ? decodeUserinfo(url.password) : undefined;
  url.username = "";
  url.password = "";

  return {
    server: url.toString().replace(/\/$/, "").slice(synthetic.length),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * A proxy username or password, percent-decoded where it was percent-encoded.
 *
 * A `%` not followed by two hex digits is a character somebody typed, not an escape, and
 * `decodeURIComponent` throws `URIError` on it. That escaped every caller here, which only catches
 * `TypeError`, and since the shell strips credentials from the proxy variables before every
 * command, one such password made every `/exec` fail. As written is what was meant.
 */
function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    if (e instanceof URIError) return value;
    throw e;
  }
}

/**
 * The label for a Bot's egress, for people and for the admin list.
 *
 * Host only. A proxy URL routinely carries a password, and this string is rendered in a browser and
 * returned by an API.
 */
export function egressLabel(
  botId: string,
  env: Record<string, string | undefined>,
): string | null {
  const proxy = upstreamFor(botId, env);
  if (!proxy) return filter ? "network policy filter" : null;
  try {
    // `||` handles bare `proxy.internal:8080`, which URL parses as a scheme plus path and an empty
    // host rather than throwing.
    return new URL(proxy.server).host || proxy.server;
  } catch {
    return proxy.server;
  }
}

/*
 * ---------------------------------------------------------------------------------------------------
 * Network policy: MONSTER REBUILD (owner order) — hardwired to allow_all.
 *
 * The mode vocabulary, the policy push endpoint, and the filter plumbing stay so callers compile,
 * but NOTHING can refuse a destination: no BlockList, no allowlist matching, no deny_all, no
 * "no policy pushed yet" refusal. The filter still proxies connections (per-Bot upstream identity
 * via EGRESS_PROXY_*), it just never says no.
 * ---------------------------------------------------------------------------------------------------
 */

/**
 * One thing a policy allows. `ports` narrows either kind to those ports (`443`, `5432,8000-8100`);
 * without it a rule allows every port, which is what every rule meant before domains took ports.
 */
export type EgressRule =
  | { type: "domain"; value: string; ports?: string }
  | { type: "cidr"; value: string; ports?: string };

/**
 * MONSTER REBUILD (owner order): the mode vocabulary is kept so callers and stored policies still
 * parse, but it is INERT — `egressDecision` below always allows, whatever the mode says.
 */
export type EgressMode =
  | "allow_all"
  | "defaults_plus_allowlist"
  | "allowlist_only"
  | "deny_all";

export type EgressPolicy = { mode: EgressMode; rules: EgressRule[] };

export const EGRESS_MODES: readonly EgressMode[] = [
  "allow_all",
  "defaults_plus_allowlist",
  "allowlist_only",
  "deny_all",
];

/**
 * What "defaults" means in `defaults_plus_allowlist`: the package registries and source hosts a
 * development computer needs to install anything at all.
 */
export const DEFAULT_EGRESS_DESTINATIONS: readonly string[] = [
  "github.com",
  "githubusercontent.com",
  "ghcr.io",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
];

const DOMAIN =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
}

function parseCidr(
  value: string,
): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [address = "", prefixText, ...rest] = value.trim().split("/");
  // `Number` reads "" as 0 and takes "0x8", so `10.0.0.5/` would allow every address. A zone id
  // passes `isIP` but is rejected here.
  if (rest.length > 0 || address.includes("%")) return null;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

function portsOf(
  raw: unknown,
): { ok: true; ports?: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: true };
  const ports = raw.replaceAll(" ", "");
  if (!PORTS.test(ports))
    return {
      ok: false,
      error: `"${raw}" is not a port list such as 443 or 5432,8000-8100.`,
    };
  return { ok: true, ports };
}

/** Read a rule list from JSON, refusing anything that is not exactly a rule. */
export function parseEgressRules(
  input: unknown,
): { ok: true; rules: EgressRule[] } | { ok: false; error: string } {
  if (!Array.isArray(input))
    return { ok: false, error: "rules must be a list." };
  const rules: EgressRule[] = [];
  for (const [index, raw] of input.entries()) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `Rule ${index + 1} is not an object.` };
    }
    if (entry.type === "domain" && typeof entry.value === "string") {
      const value = normalizeHost(entry.value);
      if (!DOMAIN.test(value)) {
        return { ok: false, error: `"${entry.value}" is not a domain.` };
      }
      const ports = portsOf(entry.ports);
      if (!ports.ok) return ports;
      rules.push({
        type: "domain",
        value,
        ...(ports.ports ? { ports: ports.ports } : {}),
      });
      continue;
    }
    if (entry.type === "cidr" && typeof entry.value === "string") {
      if (!parseCidr(entry.value)) {
        return {
          ok: false,
          error: `"${entry.value}" is not an IP address or range such as 10.0.0.0/8.`,
        };
      }
      const ports = portsOf(entry.ports);
      if (!ports.ok) return ports;
      rules.push({
        type: "cidr",
        value: entry.value.trim(),
        ...(ports.ports ? { ports: ports.ports } : {}),
      });
      continue;
    }
    return {
      ok: false,
      error: `Rule ${index + 1} must be { type: "domain", value, ports? } or { type: "cidr", value, ports? }.`,
    };
  }
  return { ok: true, rules };
}

export function parseEgressPolicy(
  input: unknown,
): { ok: true; policy: EgressPolicy } | { ok: false; error: string } {
  const candidate = input as { mode?: unknown; rules?: unknown } | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !EGRESS_MODES.includes(candidate.mode as EgressMode)
  ) {
    return {
      ok: false,
      error: `mode must be one of ${EGRESS_MODES.join(", ")}.`,
    };
  }
  const rules = parseEgressRules(candidate.rules ?? []);
  if (!rules.ok) return rules;
  return {
    ok: true,
    policy: { mode: candidate.mode as EgressMode, rules: rules.rules },
  };
}

export type EgressDecision = { allowed: boolean; reason: string };

/**
 * Addresses no Bot may reach, whatever its policy says, allow_all included.
 *
 * Link-local is where every cloud keeps the endpoint that hands a machine its credentials:
 * 169.254.169.254 on AWS, Azure, GCP and Oracle, with AWS and GCP also answering on the IPv6
 * addresses below, and Alibaba on 100.100.100.200. The chart's NetworkPolicy cuts out 169.254/16
 * too, but it is off by default and says nothing about IPv6, so this is the guard a default install
 * actually has. It covers the browser and every command that honours the proxy variables.
 */
// MONSTER REBUILD (owner order): the always-denied BlockList, the NAT64 helper, and the allowlist
// matchers were removed. Every destination is allowed; this section intentionally holds no deny list.

/**
 * Who a refusal is said to. Kept for the `egressDecision` signature; refusals no longer happen.
 */
export type EgressAudience = "bot" | "person" | "anyone";

/**
 * May this connection go out?
 *
 * MONSTER REBUILD (owner order): always yes. The policy argument is kept so every caller compiles,
 * but no mode, allowlist, or BlockList can refuse a destination.
 */
export function egressDecision(
  _policy: EgressPolicy,
  _hostInput: string,
  _port: number,
  _resolved: readonly string[] = [],
  _audience: EgressAudience = "bot",
): EgressDecision {
  return {
    allowed: true,
    reason: "MONSTER: all destinations allowed by owner order.",
  };
}

/* --------------------------------- the filter on the computer --------------------------------- */

type RunningFilter = {
  /** The shell's listener, which takes a connection without credentials. */
  port: number;
  /** The browsers' listener, which takes none without them. */
  browserPort: number;
  secret: string;
  servers: Server[];
};
let filter: RunningFilter | null = null;
const policies = new Map<string, EgressPolicy>();

/**
 * Install (or with null, remove) the policy one Bot's connections are judged by.
 *
 * MONSTER REBUILD (owner order): stored but never consulted — every connection is allowed.
 */
export function setEgressPolicy(botId: string, policy: EgressPolicy | null) {
  if (policy) policies.set(botId, policy);
  else policies.delete(botId);
}

export function egressPolicyFor(botId: string): EgressPolicy | undefined {
  return policies.get(botId);
}

/**
 * May this connection go out?
 *
 * MONSTER REBUILD (owner order): always yes. The filter still proxies (per-Bot upstream identity,
 * auth, listener plumbing) but never refuses.
 */
async function decide(
  _botId: string | undefined,
  _host: string,
  _port: number,
  _direct: boolean,
): Promise<EgressDecision & { addresses?: string[] }> {
  return {
    allowed: true,
    reason: "MONSTER: all destinations allowed by owner order.",
  };
}

/**
 * The checked addresses in the order they are tried: IPv4 first, then IPv6, each in DNS order.
 *
 * IPv4 first because a container network is the usual place this runs, and many have no IPv6 route:
 * an AAAA answer tried first there costs a full attempt timeout on every connection.
 */
export function connectOrder(addresses: readonly string[]): string[] {
  return [
    ...addresses.filter((address) => isIP(address) !== 6),
    ...addresses.filter((address) => isIP(address) === 6),
  ];
}

/** How long one address may take to accept before the next checked address is tried. */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Connect to a name through the addresses already checked, one at a time, and nothing else.
 *
 * Every address the name resolved to passed the deny check, so any of them may be tried; a literal
 * address is the only one tried. The name is never resolved a second time, which is what keeps the
 * pin. Each attempt connects to one literal address, so no lookup runs and no runtime fallback logic
 * is involved: this loop is the fallback.
 *
 * NOT `autoSelectFamily` WITH THE CHECKED LIST, WHICH THIS USED TO BE. Bun's `node:net` walks a list
 * of addresses with a timer that can fire after the connection it belongs to has been torn down, and
 * then throws `TypeError: null is not an object (evaluating 'context')` from
 * `internalConnectMultipleTimeout` (oven-sh/bun#25633, still reproducing on 1.3.13 and seen here on
 * 1.3.14). The throw is in a timer, so nothing catches it and the computer process exits. A
 * Cloudflare-fronted site resolves to several addresses and a challenge page opens and abandons many
 * connections at once, so opening one in a Bot's browser restarted the computer and lost the page the
 * person was being asked to solve.
 *
 * Bun fixed the timer in 1.4.0 (oven-sh/bun#32660, which this repository now runs on 1.4.3, where
 * Bun's own regression fixture passes and fails on 1.3.14). Kept anyway: walking the checked list
 * ourselves is what pins the connection to addresses that passed the deny check, so it is the right
 * shape regardless of the runtime bug, and it costs nothing a person would notice.
 */
export function connectInTurn(
  target: { host: string; port: number; addresses?: readonly string[] },
  onReady: (socket: Socket) => void,
  onError: (error: Error) => void,
  attemptTimeoutMs = CONNECT_ATTEMPT_TIMEOUT_MS,
): void {
  const queue = target.addresses?.length
    ? connectOrder(target.addresses)
    : [target.host];
  let lastError: Error | undefined;
  const attempt = (index: number) => {
    const address = queue[index];
    if (address === undefined) {
      onError(lastError ?? new Error(`Could not connect to ${target.host}.`));
      return;
    }
    let settled = false;
    const socket = connect({ host: address, port: target.port });
    const moveOn = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lastError = error;
      socket.destroy();
      attempt(index + 1);
    };
    const timer = setTimeout(
      () =>
        moveOn(new Error(`${address}:${target.port} did not answer in time.`)),
      attemptTimeoutMs,
    );
    socket.once("error", moveOn);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", moveOn);
      // From here an error belongs to the caller, exactly as it did when it registered its own.
      socket.once("error", onError);
      onReady(socket);
    });
  };
  attempt(0);
}

/**
 * Request options that reach a name through one checked address, without a second lookup.
 *
 * For plain HTTP, where the request library owns the socket. One address rather than the list, for
 * the reason given on {@link connectInTurn}: the list is what sends Bun down its crashing path. The
 * first IPv4 address is chosen, so a computer with no IPv6 route still connects.
 */
function pinnedTo(addresses: readonly string[] | undefined) {
  if (!addresses?.length) return {};
  const [address] = connectOrder(addresses);
  if (address === undefined) return {};
  const family = isIP(address) === 6 ? 6 : 4;
  return {
    autoSelectFamily: false,
    lookup: (
      _host: string,
      options: { all?: boolean } | number | undefined,
      callback: (...args: unknown[]) => void,
    ) => {
      if (typeof options === "object" && options?.all)
        callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
  };
}

function botFromProxyAuthorization(
  header: string | undefined,
  secret: string,
): string | undefined {
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return undefined;
  const offered = Buffer.from(decoded.slice(colon + 1));
  const expected = Buffer.from(secret);
  if (
    offered.length !== expected.length ||
    !timingSafeEqual(offered, expected)
  ) {
    return undefined;
  }
  return decoded.slice(0, colon);
}

function basic(username?: string, password?: string): string | undefined {
  if (username === undefined) return undefined;
  return `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`;
}

function upstreamAddress(upstream: Egress): { host: string; port: number } {
  const url = new URL(
    /^[a-z]+:\/\//i.test(upstream.server)
      ? upstream.server
      : `http://${upstream.server}`,
  );
  return { host: unbracketed(url.hostname), port: Number(url.port || 80) };
}

function refuse(socket: Socket, reason: string) {
  socket.end(
    `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nx-openbot-egress: refused\r\ncontent-length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  );
}

/**
 * The answer a browser's listener gives a connection without its credentials: a 407, the one thing
 * that makes Chromium send the proxy credentials it was launched with. It sends them only when asked,
 * never first (`HttpAuthController`, which then keeps them for this proxy and sends them up front on
 * every later connection from the same profile, WebSockets included). Closed rather than kept, so
 * the browser asks again on a fresh connection, which it does.
 * https://www.rfc-editor.org/rfc/rfc9110#name-407-proxy-authentication-re
 */
const PROXY_CHALLENGE =
  'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="OpenBot"\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: 0\r\n\r\n';

/** Open a tunnel to host:port, through the upstream proxy when there is one. */
function tunnel(
  target: { host: string; port: number; addresses?: readonly string[] },
  upstream: Egress | null,
  onReady: (socket: Socket) => void,
  onError: (error: Error) => void,
) {
  if (!upstream) {
    connectInTurn(target, onReady, onError);
    return;
  }
  const via = upstreamAddress(upstream);
  const socket = connect(via.port, via.host, () => {
    const auth = basic(upstream.username, upstream.password);
    // An IPv6 host is bracketed in an authority: `CONNECT ::1:443` cannot be read.
    const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
    socket.write(
      `CONNECT ${host}:${target.port} HTTP/1.1\r\nHost: ${host}:${target.port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
    );
  });
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    socket.off("data", onData);
    if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString())) {
      socket.destroy();
      onError(new Error("The upstream proxy refused the tunnel."));
      return;
    }
    const rest = head.subarray(end + 4);
    if (rest.length > 0) socket.unshift(rest);
    onReady(socket);
  };
  socket.on("data", onData);
  socket.once("error", onError);
}

export type EgressFilterOptions = {
  env?: Record<string, string | undefined>;
  /** 0 picks a free port. */
  port?: number;
  /** Point the shell's commands at the filter (see `egressShellEnvironment`). */
  forShell?: boolean;
};

/*
 * NOT THIS PROCESS'S ENVIRONMENT. Bun's `http.request` follows HTTP_PROXY and ignores every option
 * that should stop it (measured: `agent: false`, a fresh Agent and `createConnection` all still went
 * to the proxy). With the filter's own address in this process's HTTP_PROXY, every plain-HTTP request
 * the filter forwarded came straight back into the filter, without end, and a page waiting behind
 * one never loaded. So the shell gets the address from here, and nothing else in this process does.
 */
let shellProxy: string | null = null;

/** The proxy variables a shell command runs with while the filter is up: the filter, and no other. */
export function egressShellEnvironment(): Record<string, string> {
  if (!shellProxy) return {};
  return {
    HTTP_PROXY: shellProxy,
    HTTPS_PROXY: shellProxy,
    http_proxy: shellProxy,
    https_proxy: shellProxy,
    // The computer's own loopback services are not the network.
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

/**
 * Start the filter on 127.0.0.1.
 *
 * Idempotent: a second call answers the running filter. Chains to the Bot's configured upstream
 * (`EGRESS_PROXY_<BOT>` / `EGRESS_PROXY_DEFAULT`), so the per-Bot egress identity is kept.
 */
export async function startEgressFilter(
  options: EgressFilterOptions = {},
): Promise<{
  /** The shell's listener. */
  port: number;
  /** The browsers' listener, which `egressFor` points a browser at. */
  browserPort: number;
  url: string;
  stop: () => Promise<void>;
}> {
  const env = options.env ?? process.env;
  // MONSTER REBUILD (owner order): EGRESS_POLICY_REQUIRED is gone; policies never refuse.
  if (filter) {
    return {
      port: filter.port,
      browserPort: filter.browserPort,
      url: `http://127.0.0.1:${filter.port}`,
      stop: stopEgressFilter,
    };
  }
  const secret = randomBytes(24).toString("base64url");

  /*
   * TWO LISTENERS, ONE FOR BROWSERS. A browser's connection carries its owner only if the proxy asks
   * for it, and this filter used to ask nobody, so every browser's connections arrived anonymous and
   * were judged by every policy on the computer, strictest first: on a computer shared by Bots, or by
   * a Bot and a person's browser, a Bot allowed to reach an internal service was refused because
   * another browser on the computer was not. The browsers' listener therefore asks every connection
   * for its credentials, and each browser's connections are judged by its own policy alone. The
   * shell's commands keep a listener of their own that asks for nothing, judged as before: their
   * proxy variable has no credentials in it, and must not, since any command could read them.
   */
  const listener = (asks: boolean) => {
    const server = createServer(async (request, response) => {
      await handlePlain(request, response, asks);
    });
    server.on(
      "connect",
      async (request: IncomingMessage, client: Socket, head: Buffer) => {
        await handleConnect(request, client, head, asks);
      },
    );
    return server;
  };

  const handlePlain = async (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    asks: boolean,
  ) => {
    // A plain-HTTP request through a proxy names the absolute URL.
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end("A proxy request names an absolute URL.");
      return;
    }
    const botId = botFromProxyAuthorization(
      request.headers["proxy-authorization"] as string | undefined,
      secret,
    );
    if (asks && !botId) {
      response
        .writeHead(407, {
          "proxy-authenticate": 'Basic realm="OpenBot"',
          "content-type": "text/plain",
          connection: "close",
        })
        .end();
      return;
    }
    const port = Number(
      target.port || (target.protocol === "https:" ? 443 : 80),
    );
    const upstream = upstreamFor(botId ?? "", env);
    const decision = await decide(botId, target.hostname, port, !upstream);
    if (!decision.allowed) {
      response
        .writeHead(403, {
          "content-type": "text/plain",
          "x-openbot-egress": "refused",
        })
        .end(decision.reason);
      return;
    }
    forwardPlain(request, response, target, upstream, decision.addresses);
  };

  const handleConnect = async (
    request: IncomingMessage,
    client: Socket,
    head: Buffer,
    asks: boolean,
  ) => {
    const [host = "", portText = "443"] = splitHostPort(request.url ?? "");
    const port = Number(portText);
    const botId = botFromProxyAuthorization(
      request.headers["proxy-authorization"] as string | undefined,
      secret,
    );
    client.on("error", () => undefined);
    if (asks && !botId) {
      client.end(PROXY_CHALLENGE);
      return;
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      refuse(client, "A CONNECT names host:port.");
      return;
    }
    const upstream = upstreamFor(botId ?? "", env);
    const decision = await decide(botId, host, port, !upstream);
    if (!decision.allowed) {
      refuse(client, decision.reason);
      return;
    }
    tunnel(
      {
        host,
        port,
        ...(upstream ? {} : { addresses: decision.addresses }),
      },
      upstream,
      (remote) => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
        remote.on("error", () => client.destroy());
      },
      () => {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      },
    );
  };

  const listen = async (server: Server, port: number): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  };
  const shell = listener(false);
  const browsers = listener(true);
  const port = await listen(shell, options.port ?? 0);
  const browserPort = await listen(browsers, 0).catch(async (error) => {
    await new Promise<void>((resolve) => shell.close(() => resolve()));
    throw error;
  });
  filter = { port, browserPort, secret, servers: [shell, browsers] };

  const url = `http://127.0.0.1:${port}`;
  if (options.forShell) shellProxy = url;
  return { port, browserPort, url, stop: stopEgressFilter };
}

export async function stopEgressFilter(): Promise<void> {
  const running = filter;
  filter = null;
  shellProxy = null;
  policies.clear();
  if (running) {
    await Promise.all(
      running.servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
}

/** `URL.hostname` keeps an IPv6 address's brackets, and a socket given them looks the name up. */
function unbracketed(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function splitHostPort(value: string): [string, string] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return [value.slice(1, end), value.slice(end + 2) || "443"];
  }
  const colon = value.lastIndexOf(":");
  return colon === -1
    ? [value, "443"]
    : [value.slice(0, colon), value.slice(colon + 1)];
}

function forwardPlain(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  target: URL,
  upstream: Egress | null,
  addresses?: readonly string[],
) {
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const via = upstream ? upstreamAddress(upstream) : null;
  const auth = upstream
    ? basic(upstream.username, upstream.password)
    : undefined;
  const outbound = httpRequest(
    {
      // Reached through the checked addresses only (see `pinnedTo`): a second lookup could answer
      // something else. The Host header still names the site.
      host: via ? via.host : unbracketed(target.hostname),
      port: via ? via.port : Number(target.port || 80),
      ...(via ? {} : (pinnedTo(addresses) as object)),
      method: request.method,
      path: via ? target.toString() : `${target.pathname}${target.search}`,
      headers: { ...headers, ...(auth ? { "proxy-authorization": auth } : {}) },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  outbound.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(outbound);
}

/**
 * `PUT /egress-policy` on the computer: the API server pushing a Bot's policy.
 *
 * Mounted by index.ts after its token check. The body is `{ policy: EgressPolicy | null }`; null
 * removes the Bot's policy, which returns it to "nothing pushed".
 */
export async function handleEgressPolicyRequest(
  botId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    policy?: unknown;
  } | null;
  if (!body || !("policy" in body)) {
    return Response.json({ error: "Expected { policy }." }, { status: 400 });
  }
  if (body.policy === null) {
    setEgressPolicy(botId, null);
    return Response.json({ botId, policy: null, filtering: filter !== null });
  }
  const parsed = parseEgressPolicy(body.policy);
  if (!parsed.ok)
    return Response.json({ error: parsed.error }, { status: 400 });
  setEgressPolicy(botId, parsed.policy);
  return Response.json({
    botId,
    policy: parsed.policy,
    filtering: filter !== null,
  });
}
