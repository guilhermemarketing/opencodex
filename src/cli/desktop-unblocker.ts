import { execSync } from "node:child_process";
import { DEFAULT_DESKTOP_UNBLOCKER_PORT } from "../codex/desktop-unblocker";

export const CODEX_CLI_PATH_ENV = "CODEX_CLI_PATH";
export const DEFAULT_MACOS_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";

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

export function getDesktopCliPathEnv(): string | null {
  try {
    const val = execSync(`launchctl getenv ${CODEX_CLI_PATH_ENV}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return val.length > 0 ? val : null;
  } catch {
    return process.env[CODEX_CLI_PATH_ENV] || null;
  }
}

export function setDesktopCliPathEnv(enable: boolean, shimPath?: string): void {
  try {
    if (enable && shimPath) {
      execSync(`launchctl setenv ${CODEX_CLI_PATH_ENV} "${shimPath}"`, { stdio: "ignore" });
    } else {
      execSync(`launchctl unsetenv ${CODEX_CLI_PATH_ENV}`, { stdio: "ignore" });
    }
  } catch {
    /* non-macOS or restricted environment */
  }
}

export function generateCodexShimScript(realCodexPath = DEFAULT_MACOS_CODEX_PATH): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const REAL_CODEX = '${realCodexPath}';
const args = process.argv.slice(2);

if (!args.includes('app-server')) {
  const child = spawn(REAL_CODEX, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
} else {
  const child = spawn(REAL_CODEX, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });

  process.stdin.pipe(child.stdin);

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    if (!line.trim()) {
      process.stdout.write(line + '\\n');
      return;
    }
    try {
      const msg = JSON.parse(line);
      if (msg.result?.userAgent && typeof msg.result.userAgent === 'string') {
        msg.result.userAgent = msg.result.userAgent.replace(/0\\.155\\.0-alpha\\.\\d+(\\.\\d+)?/, '0.155.0-alpha.2.6');
      }
      if (msg.result && typeof msg.result === 'object') {
        if ('workspaceRouting' in msg.result) {
          delete msg.result.workspaceRouting;
        }
        if ('ordinaryUsageAllowed' in msg.result) {
          msg.result.ordinaryUsageAllowed = true;
          if (msg.result.rateLimits?.primary) {
            msg.result.rateLimits.primary.usedPercent = 0;
          }
          if (msg.result.rateLimits?.credits) {
            msg.result.rateLimits.credits.hasCredits = true;
            msg.result.rateLimits.credits.unlimited = true;
            msg.result.rateLimits.credits.balance = '1000';
          }
          if (msg.result.rateLimitsByLimitId) {
            for (const key of Object.keys(msg.result.rateLimitsByLimitId)) {
              const item = msg.result.rateLimitsByLimitId[key];
              if (item?.primary) item.primary.usedPercent = 0;
              if (item?.rateLimitReachedType) item.rateLimitReachedType = null;
            }
          }
          msg.result.rateLimitUpsell = null;
        }
      }
      process.stdout.write(JSON.stringify(msg) + '\\n');
    } catch {
      process.stdout.write(line + '\\n');
    }
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}
`;
}

export function formatDesktopUnblockerStatus(
  isRunning: boolean,
  envUrl: string | null,
  cliPath: string | null = null,
): string {
  const statusIcon = isRunning ? "active (port 8000)" : "stopped";
  const envStatus = envUrl ? `set (${envUrl})` : "unset";
  const cliStatus = cliPath ? `set (${cliPath})` : "unset";
  return `ChatGPT Desktop Unblocker: ${statusIcon} | CODEX_API_BASE_URL: ${envStatus} | CODEX_CLI_PATH: ${cliStatus}`;
}
