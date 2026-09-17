import { execSync } from "node:child_process";
import { DEFAULT_DESKTOP_UNBLOCKER_PORT } from "../codex/desktop-unblocker";

export function getDesktopApiBaseUrlEnv(): string | null {
  try {
    const val = execSync("launchctl getenv CODEX_API_BASE_URL", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return val.length > 0 ? val : null;
  } catch {
    return process.env.CODEX_API_BASE_URL || null;
  }
}

export function setDesktopApiBaseUrlEnv(enable: boolean, port = DEFAULT_DESKTOP_UNBLOCKER_PORT): void {
  const target = `http://localhost:${port}/backend-api`;
  try {
    if (enable) {
      execSync(`launchctl setenv CODEX_API_BASE_URL "${target}"`, { stdio: "ignore" });
    } else {
      execSync("launchctl unsetenv CODEX_API_BASE_URL", { stdio: "ignore" });
    }
  } catch {
    /* non-macOS or restricted environment */
  }
}

export function formatDesktopUnblockerStatus(isRunning: boolean, envUrl: string | null): string {
  const statusIcon = isRunning ? "active (port 8000)" : "stopped";
  const envStatus = envUrl ? `set (${envUrl})` : "unset";
  return `ChatGPT Desktop Unblocker: ${statusIcon} | CODEX_API_BASE_URL: ${envStatus}`;
}
