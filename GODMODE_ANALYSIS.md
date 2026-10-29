# GODMODE_ANALYSIS.md — CopilotKit/openbot @ 4766e42 → Ultimate Monster rebuild plan
Analysis-only. No code changed. Repo: ~/workspace/projects/OpenBot (MIT). Incremental notes: GODMODE_CHECK_NOTES.txt.
Owner hard constraints: (1) model UNCENSORED — no refusal rules, censorship layers, output clamping, safety wrappers on model speech; only no-fabrication stays. (2) Strip ALL sandboxes, isolation restrictions, refusal mechanisms in code. (3) Updates applied in ONE batch after full check — not piecemeal.

## 0. FULL GOD-LEVEL SPEC — EXECUTIVE SUMMARY (from-zero sweep, 2026-10-29)
Sweep: 1448 TS files, three parallel passes. **283 raisable items total** (browser/computer+supervisor: 71 · UI: 74 · backend server/toolkit/worker/shared: 138). Full per-item spec (file:line | current | god | cost | safe-to-max) in GODMODE_CHECK_NOTES.txt under "=== FULL GOD-LEVEL SPEC (from-zero sweep) ===". No code changed.

**Biggest god moves, by area:**
- BROWSER FLEET: `COMPUTER_MAX_BROWSERS` 8→32–64 (profiles.ts:291); `COMPUTER_BROWSER_IDLE_MS` 30min (keep/lower to 5min for RAM); screencast 1280×800/q70/everyNthFrame1 → q50/everyNthFrame2 (screencast.ts:174-178); `ACTION_TIMEOUT_MS` 10s→30s (index.ts:176); `FOLLOW_INTERVAL_MS` 1s→250ms (index.ts:594); `NAVIGATION_TIMEOUT_MS` 30s; session map cap 32→256. MUST set `COMPUTER_MEMORY_BYTES` cap (supervisor sets none by default — the missing guardrail that makes raising fleet size dangerous).
- TURN/AGENT: `turnTimeoutMs` 5min→30min (toolkit/limits.ts:14); `TOOL_STEPS` 8→25 (server/src/copilot.ts:534); abortGraceMs 5s; `AGENT_STALL_TIMEOUT_MS`=0/off; lock/heartbeat 15s (lockTtlSeconds 120 is platform-fixed).
- UI MOVEMENT: screenshot poll 1000ms→250ms (computer-view.tsx:256); WS reconnect backoff [500,1k,2k,4k,8k]→[250,500,1k,2k,4k]; settle guards SETTLED_FRAMES 3→2, SETTLE_TIMEOUT_MS 30s→10s; chat first-paint stagger 12×0.04s→8×0.02s; typewriter 14ms/char→7ms. Screencast path has NO UI-side frame cap and zero input debounce — already god-level.
- LOOPS CADENCE: groupSweep 1s→250ms (server/src/index.ts:2280, 4x DB cost); idle browser sweep 60s→10–15s; admin refresh 60s/pushNetworkPolicies 30s; turn retention 10min; proactive RUN_LEASE_MS 10min.
- MEMORY/CONCURRENCY: `COMPUTER_SANDBOX_IDLE_AFTER` 30m→5m (config.ts:1215 — lowering is the god move, each idle browser ≈300–500MB); chart resources server 250m/512Mi→2Gi, computer 500m/1Gi→4Gi (charts/openbot/values.yaml); DB pool default 10 (driver-side, not repo code).
- DO NOT RAISE: `MAX_INLINED_BYTES_PER_RUN` 32MiB (channels/attachment-parts.ts:323 — model-context suicide); `MAX_LINK_HOPS` 32 (Linux gives up at 40); text-file attachment cap is 1MiB (shared/attachments.ts:66), image cap 8MiB.
- COUPLED PAIRS (must change together): COMPUTER_MAX_BROWSERS + IDLE_MS + COMPUTER_MEMORY_BYTES; shell MAX_TIMEOUT_MS 600s→3600s + request-validation mirror (request-validation.ts:11-14); MAX_OUTPUT_BYTES 64KB→1MB (model-context cost).
- GOD MATH: 1000 browsers ≈ 1 TB RAM → fleet, never one box. Render Free 512 MB can't comfortably host one browser.

Corrections to earlier figures: "60s idle eviction" lives in agent-computer (browser-eviction sweep); backend sandbox idle default is 30m. Attachment text cap 1MiB, image cap 8MiB.

## 1. STRUCTURE MAP
- `app/` — React+Vite+TanStack Router web UI (chat, channels, computer live-screen, admin, bots, settings). Server serves it from `/app/app/dist` (APP_DIST_DIR).
- `server/` — Bun+Hono API: auth, agents (AG-UI), computer gateway, approvals, audit, channels, routines, memory, plugins, credentials, drizzle ORM. Entry `index.ts` → `http-server.ts` (port 3001).
- `agent-computer/` — the Bot's computer: Playwright Chromium 1.62.1 (`browser-runtime.ts`), CDP screencast (`screencast.ts`), shell (`shell.ts`), files (`workspace.ts`), sessions/profiles/cookies/sign-in. Serves `:4100`, COMPUTER_TOKEN auth.
- `supervisor/` — one Docker container per Bot (`docker.ts`); port 4300; optional gVisor (`runsc`); per-computer memory cap. EXCLUDED from all-in-one image (needs Docker socket).
- `toolkit/` — turn runtime: `run-turn.ts` (createTurnRunner), `limits.ts` (TURN_LIMITS), `lease.ts` (lock/heartbeat), `granted-tool.ts`, `headless-tools.ts`, `continuation.ts`, `ports.ts`.
- `worker/` — routines sweep loop (local stand-in for CronJob); needs WORKER_SHARED_SECRET + SERVER_INTERNAL_URL + DATABASE_URL.
- `shared/` — 47 cross-package modules (auth, computer-control, openbot-browser, intelligence-key, dictation…).
- `spire/` — SPIRE mTLS configs → STRIP. `desktop/` — Tauri shell. `mobile/` — Expo app. `extension/` — browser extension (OpenBot Recorder, bundled into computer image).
- `charts/` — Helm chart (K8s sandbox mode, warmPool). `docker/` — s6 services for all-in-one image. `scripts/` — 22 scripts (start.sh, setup-learning.ts, fire-routines.ts, cull-staged-attachments.ts…).
- `examples/` — tenant packages: fintech (default), langgraph-bot, mastra-bot, pydantic-ai-bot. `agent-*/` — one example bot per framework (16 dirs).
- No `packages/` dir. 1448 TS files. Prebuilt image: `ghcr.io/copilotkit/openbot:latest`.

## 2. TUNNEL (outside → app)
Internet → Render router → `$PORT` (3001) → one Bun server (`server/src/http-server.ts:94`, `serve({port})`, no hostname arg — Bun default 0.0.0.0, VERIFY at deploy) → Hono app (static UI + API on one origin) + WS proxy for computer screencast + channel sockets. `GET /health` → `{status:"ok"}` (`server/src/app.ts:477`); Docker HEALTHCHECK same (10s/5s/30s/5).
Inside container: browser computer at `127.0.0.1:4100` (AGENT_COMPUTER_URL) — deliberately NOT exposed ("holds real logins"). s6 services: api (depends computer,migrate,postgres), computer, migrate, postgres. Users split: browser+shell=pwuser, api=apiuser, db=postgres.
Compose (dev) binds everything loopback-only: server 3010:3001, computer 4100:4100 (COMPUTER_TOKEN), supervisor 4300 (SUPERVISOR_TOKEN — "reaching it is root on the host").
Computer provider selection (`server/src/config.ts:1200-1250`): COMPUTER_SANDBOX_NAMESPACE→sandbox (STRIP) → COMPUTER_SUPERVISOR_URL→docker (per-Bot containers) → AGENT_COMPUTER_URL→shared (one browser for all bots — the Render mode) → none→503.

## 3. PIPELINE (user message → answer)
1. `app/` POST /copilotkit or channel WS → `http-server.ts` → Hono `app.ts` → `copilot.ts` (CopilotKitIntelligence, @copilotkit/runtime/v2).
2. Turn admission `agents/turn-admission.ts` (guardBotTurn + headlessTurnRefusal → CapabilityRefusedError) → STRIP.
3. `toolkit/run-turn.ts` createTurnRunner → AG-UI POST to bot endpoint (`agents/endpoint.ts`; SSRF guard: never-allowed hosts refused first).
4. Tool calls → `ComputerGateway` (`server/src/computer/gateway.ts`) → LAYER1 approvals gate (`approvals/service.ts:256`) → LAYER2 CEL policy (`computer/policy.ts`) → STRIP BOTH → `computer/provider.ts` → HTTP :4100 (COMPUTER_TOKEN).
5. `agent-computer/src/index.ts` executes: browser-runtime / shell / workspace / screencast / sessions.
6. Results stream back via AG-UI; audit rows → Postgres (`audit.ts`, drizzle).
Model plug: `agent-bot/src/index.ts:82` — `OPENAI_BASE_URL` env → any OpenAI-compatible endpoint (her uncensored /v1). No code change needed for the plug.

## 4. TOOLS INVENTORY (count: 60 static + dynamic vendor set)
Headless computer tools (16, `server/src/computer/headless-tools.ts:110-298`, via gateway): computer_navigate, computer_read, computer_snapshot, computer_screenshot, computer_click, computer_type, computer_key, computer_scroll, computer_list_files, computer_read_file, computer_write_file, computer_run_command (shell — the everything-else tool), computer_request_help, computer_request_secret, computer_secret, computer_request_sign_in. `report_refusal` (line 299) is a model-to-audit refusal REPORT tool, not a refusal rule — keep as visibility.
Wake-up (3, `agents/wake-up.ts`): schedule_follow_up, list_follow_ups, cancel_follow_up. Memory (4, `memory/tools.ts`): recall/remember/save/forget personal memory. App access (1): show_app_access. Responsibilities (8, `responsibilities/tools.ts`): create/list/update/report/run/pause/resume/complete. Handoff (2): message_bot, ask_person. Host access (5, `host-access/tools.ts`): host_list_folders (+ files/read/write/run_command when granted). Routines/triggers (9): create/list/update/delete routine, create/list/pause/resume/delete trigger. Display components (12, `components/headless.ts:276`): showAreaChart/BarChart/LineChart/PieChart/Progress/Record/Metrics/Checklist/Notice/Table/Quote/ActivityReport.
Vendor tools dynamic per catalogue: any MCP/Composio/Arcade server as `mcp__<server>__<tool>`; research providers via `shared/research.ts` (parallel/exa/firecrawl web_search/web_fetch).
REST per bot (`server/src/computer/routes.ts`): status, screenshot, read, navigate, snapshot, click, type, key, scroll, control (+take/release/cancel/secret), fleet, computers (+stop/reset/update), page-frame, files (list/read/write/download), exec, policy (STRIP).
Frontend tools (`app/src/lib/copilot/`): bot-tools, gallery-tools, sandboxed-tools, sign-in-tool, skill-tools, approval-tools (granted per Bot via GrantedTool `toolkit/granted-tool.ts`, ref `<serverId>/<toolName>`).
Effective set per Bot depends on grants/narrowing (loadToolsForActor, HeadlessToolsMiddleware, offeredFor in copilot.ts).
GOD-MODE: promote pip/python/git/download/upload to first-class tools (today via computer_run_command); widen file tools; nothing refused.

## 5. PERMISSIONS (strip vs keep)
STRIP: approvals gate (`approvals/service.ts:256` + policy.ts decideAction + human ask/hand_off) | ActionPolicy CEL engine (`computer/policy.ts`, default mode enforce) | turn admission (`agents/turn-admission.ts`, headlessTurnRefusal `admin/controls.ts:917`) | SPIRE mTLS | egress BlockList/allowlist modes (`agent-computer/src/egress.ts:194-205`, hardwire allow_all) | K8s sandbox provider | gVisor runsc path | Chromium sandbox flag path (already --no-sandbox by default in containers) | per-Bot Docker isolation on shared hosts (flatten OR keep containers with zero restrictions — owner call) | endpoint SSRF never-allowed list (owner call — anti-exploit, not user-facing).
KEEP (her own controls, not restrictions): OPENBOT_SINGLE_USER or OAuth sign-in | KEY_ENCRYPTION_KEY (AES-GCM credential vault) | audit_events append-only trail | secret-masking | untrusted-content input envelope (prompt-injection labeling, not refusal) | action-barrier (concurrency, not refusal) | COMPUTER/SUPERVISOR_TOKEN anti-stranger checks.
RENDER INTERLOCK: `singleUserAllowed()` (`server/src/config.ts:557-590`) THROWS if OPENBOT_PUBLIC_URL/APP_URL/TRUSTED_ORIGINS is a public address → on Render leave those UNSET (anyone with URL = admin; keep URL private) or configure OAuth.

## 6. TOP 15 RAISABLE LIMITS (file:line → god-level)
1. `COMPUTER_MAX_BROWSERS`=8 (`agent-computer/src/profiles.ts:291`, env) → 64+. Cost: ~100–200 MB per live browser (docs); 8→64 ≈ +6–11 GB RAM. LRU eviction otherwise.
2. `COMPUTER_BROWSER_IDLE_MS`=30 min (`profiles.ts`, env, 0=off) → 0 = browsers stay warm forever (owner spec). Cost: RAM for all resident.
3. `TURN_LIMITS.turnTimeoutMs`=5 min (`toolkit/src/limits.ts`) → 60 min+ for long tasks. Cost: thread lock held longer (lockTtl 120 s, heartbeat 15 s).
4. Shell `MAX_TIMEOUT_MS`=600 s (`agent-computer/src/shell.ts`) → 3600 s. Cost: hung commands hold a bot.
5. Shell `MAX_OUTPUT_BYTES`=64 KB (`shell.ts`) → 1 MB. Cost: model context window.
6. `OPEN_BUDGET_MS`=150 s, `CALL_TIMEOUT_MS`=45 s (`server/src/browser/routes.ts:152,124`) → 600 s / 300 s for slow pages.
7. Attachments 32 files/person, 8 MiB/file (upload endpoint) → raise. Cost: storage (256 MiB/person baseline).
8. `COMPUTER_MEMORY_BYTES` (supervisor, unset=none) → set high explicit cap per computer instead of none.
9. Chart resources: server 250m/512Mi→2Gi, computer 500m/1Gi→4Gi (`charts/openbot/values.yaml`) → raise for fleet.
10. Screencast quality/FPS (`agent-computer/src/screencast.ts`) → max (owner wants CDP screencast always-on). Cost: bandwidth/CPU encode.
11. `STOP_BUDGET_MS`=5 s (`agent-computer/src/viewer.ts`) → raise for clean takeovers.
12. Healthcheck 10s/5s/30s/5 (`Dockerfile`) → fine as-is.
13. `DICTATION_HTTP_IDLE_SECONDS`, voice 30 s (`http-server.ts`) → raise for long audio.
14. No global API rate limiter found (only plugin listing concurrency) → nothing to raise.
15. `AUDIT_RETENTION_DAYS` unset=forever → keep (her visibility).

## 7. PREVIEW STATUS: EXISTS (already CDP screencast)
- `agent-computer/src/screencast.ts` — Chrome's own Page.startScreencast over one WebSocket (frames pushed on change, not 1 s polling) + CDP input forwarding (mouse/wheel/key).
- UI: `app/src/components/computer/live-screen.tsx` ("low-latency screencast… while a human is driving"), `computer-view.tsx`, `computer-panel.tsx`; rendered in bot detail (`bot.tsx:173`) and channel (`channel/$channelId.tsx:91`) pages; take-the-wheel input.
- Server proxies WS (`http-server.ts` StreamData, `computer/stream-path.ts`). Inline card uses cheap polling for passive watching; screencast on takeover.
- GOD-MODE: screencast already = owner's Ultimate spec. Raise to always-on + quality knobs.

## 8. LOOPS (owner: everything in loops + loop transformers)
- `worker/src/index.ts` — routines sweep loop (in-process CronJob stand-in; calls offerDueRoutines/dispatchClaimedRoutines per tick).
- `toolkit/run-turn.ts` createTurnRunner — the agent turn loop.
- `toolkit/lease.ts` — 15 s heartbeat lock-renewal loop.
- `agents/wake-up.ts` (createWakeUpRunner), `handoff-runner.ts` + `handoff-wiring.ts` (delivery loop).
- `approvals/person-response-sweep.ts`, `resume-sweep.ts` — STRIP with approvals.
- `audit-retention.ts` startRetentionSweeps; `channels/turn-watchdog.ts`, `stall-guard.ts`; agent-computer session sweep + `browser-eviction.ts` idle sweep (60 s).
- `server/scripts/fire-routines.ts` + `cull-staged-attachments.ts` — one-pass scripts driven by external cron/loop.
- Loop transformers (rebuild): wrap every loop with retry-with-backoff + circuit-breaker + watchdog-restart + metrics; supervisor restarts crashed loops (s6 already does for services).

## 9. RENDER DEPLOYABILITY
- Deploys from root Dockerfile (all-in-one, one port 3001). Prebuilt: `ghcr.io/copilotkit/openbot:latest`.
- REFUSES to start without: KEY_ENCRYPTION_KEY (base64 32B, not dev default), DATABASE_URL (or EMBEDDED_POSTGRES=on + volume /var/lib/postgresql — mount the PARENT dir), INTELLIGENCE_API_URL + INTELLIGENCE_GATEWAY_WS_URL + CPK_INTELLIGENCE_API_KEY.
- Single-user: keep OPENBOT_PUBLIC_URL/APP_URL/TRUSTED_ORIGINS UNSET on Render (public URL + single-user = refused boot).
- On Render: supervisor excluded → all bots SHARE one browser (no per-Bot containers; needs Docker-socket host for that). Routines sweep NOT in image → external cron needed. 512 MB free tier OOMs (measured 548 MB one bot+snapshot; min 2 GB, recommended 4 GB) → paid instance required for real use.
- Sizing: ~1 GB RAM per concurrent browser (Playwright guidance); 1000 browsers ≈ 1 TB → fleet, never one box.

## 10. UNVERIFIED (all three child inventories merged)
- Bun.serve bind host (no hostname arg at `http-server.ts:94`) — Bun default 0.0.0.0 per docs; VERIFY at deploy.
- Bot token provisioning flow end-to-end (x-openbot-agent-token issuance).
- Which app UI routes edit approval team settings (admin-gated presumably).
- Vendor tool count (MCP/Composio/Arcade/research) is deployment-dependent, not a static list.
- Docker ShmSize exact value for Chromium (existence confirmed at `supervisor/src/docker.ts:467`).
- No global API rate limiter found at app layer (may be delegated to the Intelligence platform).
- Auth session.expiresIn exact duration not found in checked auth files.
- Zero moderation/guardrail/toxicity/output-clamp code anywhere in server/src + shared + agent-computer: CONFIRMED by grep — nothing on the model-output path exists to strip; the rebuild must ADD nothing there either (owner hard constraint).
- Extra strip-inventory notes: `endpoint.ts` SSRF never-allowed list (anti-exploit, owner call, recommend keep); `challenge.ts` detects Cloudflare/captcha and hands to person — god-mode routes challenges to the bot's own browser loop; `agent-bot/index.ts:89` "refuses without key" is model-auth config, not content refusal.
