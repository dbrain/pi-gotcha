import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { userConfigDir } from "./settings.ts";

/* Temporary instrumentation for the 2026-09-13 incident in DEFECTS.md: a retired gotcha was
   auto-injected 51 minutes after deletion, with its pre-update text — something the checked-out
   code cannot produce. PI_GOTCHA_DEBUG=1 logs the whole surfacing path — tool_call, stage,
   flush and deliver — so one live run shows what the running process actually saw at each step:
   the resolved root, the store signature at the moment, the pid (a second process would show as
   a second pid), and the ids, summaries and texts involved. Remove once the incident is
   explained. The log lives beside the user settings; PI_GOTCHA_DEBUG_FILE moves it. */

export function debugLog(event: string, fields: Record<string, unknown>): void {
  if (process.env.PI_GOTCHA_DEBUG !== "1" && process.env.PI_GOTCHA_DEBUG !== "true") return;
  try {
    const file = process.env.PI_GOTCHA_DEBUG_FILE || join(userConfigDir(), "debug.log");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...fields })}\n`);
  } catch {
    /* instrumentation must never break the turn */
  }
}
