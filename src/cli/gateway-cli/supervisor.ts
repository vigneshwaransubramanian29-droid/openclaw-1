import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { Command } from "commander";
import { resolveGatewayProgramArguments } from "../../daemon/program-args.js";
import { CONFIG_PATH } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { inheritOptionFromParent } from "../command-options.js";
import { forceFreePortAndWait } from "../ports.js";

const log = createSubsystemLogger("gateway/supervisor");

type SupervisorRunOpts = {
  port?: unknown;
  activePort?: unknown;
  passivePort?: unknown;
  healthTimeoutMs?: unknown;
  drainMs?: unknown;
  force?: boolean;
};

type WorkerSlot = {
  port: number;
  child: ChildProcess;
};

const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;
const DEFAULT_DRAIN_MS = 5_000;

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const value = Math.floor(raw);
    return value > 0 ? value : null;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      const value = Math.floor(parsed);
      return value > 0 ? value : null;
    }
  }
  return null;
}

function resolveSupervisorRunOptions(opts: SupervisorRunOpts, command?: Command): SupervisorRunOpts {
  const parentPort = inheritOptionFromParent<string>(command, "port");
  const parentForce = inheritOptionFromParent<boolean>(command, "force");
  return {
    ...opts,
    port: opts.port ?? parentPort,
    force: Boolean(opts.force || parentForce),
  };
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(500, () => done(false));
    });
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`worker port ${port} did not become ready within ${timeoutMs}ms`);
}

async function startWorker(port: number): Promise<WorkerSlot> {
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({ port });
  const command = programArguments[0];
  const args = programArguments.slice(1);
  const child = spawn(command, args, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_SUPERVISOR_CHILD: "1",
    },
    stdio: "inherit",
  });
  return { port, child };
}

function stopWorker(worker: WorkerSlot, force = false): void {
  if (worker.child.exitCode !== null || worker.child.killed) {
    return;
  }
  if (process.platform === "win32") {
    worker.child.kill();
    return;
  }
  worker.child.kill(force ? "SIGKILL" : "SIGTERM");
}

function writeUpgradeRequest(req: http.IncomingMessage, upstream: net.Socket, head: Buffer): void {
  const startLine = `GET ${req.url ?? "/"} HTTP/1.1\r\n`;
  const headers = Object.entries(req.headers)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map((entry) => `${key}: ${entry}\r\n`).join("");
      }
      if (typeof value === "undefined") {
        return "";
      }
      return `${key}: ${value}\r\n`;
    })
    .join("");
  upstream.write(`${startLine}${headers}\r\n`);
  if (head.length > 0) {
    upstream.write(head);
  }
}

function createRouter(params: { resolveTargetPort: () => number }): http.Server {
  const server = http.createServer((req, res) => {
    const targetPort = params.resolveTargetPort();
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`gateway supervisor upstream error: ${String(err)}`);
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const targetPort = params.resolveTargetPort();
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
    upstream.on("connect", () => writeUpgradeRequest(req, upstream, head));
    upstream.on("error", () => {
      socket.destroy();
    });
    socket.on("error", () => {
      upstream.destroy();
    });
    socket.pipe(upstream).pipe(socket);
  });

  return server;
}

export async function runGatewaySupervisorCommand(opts: SupervisorRunOpts): Promise<void> {
  const port = parsePositiveInt(opts.port) ?? 18789;
  const activePort = parsePositiveInt(opts.activePort) ?? port + 1;
  const passivePort = parsePositiveInt(opts.passivePort) ?? port + 2;
  if (activePort === passivePort || activePort === port || passivePort === port) {
    defaultRuntime.error("Supervisor ports must be unique.");
    defaultRuntime.exit(1);
    return;
  }
  const healthTimeoutMs = parsePositiveInt(opts.healthTimeoutMs) ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const drainMs = parsePositiveInt(opts.drainMs) ?? DEFAULT_DRAIN_MS;

  if (opts.force) {
    await forceFreePortAndWait(port, { timeoutMs: 2000, intervalMs: 100, sigtermTimeoutMs: 700 });
    await forceFreePortAndWait(activePort, {
      timeoutMs: 2000,
      intervalMs: 100,
      sigtermTimeoutMs: 700,
    });
    await forceFreePortAndWait(passivePort, {
      timeoutMs: 2000,
      intervalMs: 100,
      sigtermTimeoutMs: 700,
    });
  }

  let active = await startWorker(activePort);
  await waitForPort(active.port, healthTimeoutMs);
  let passive: WorkerSlot | null = null;
  log.info(`active worker started on port ${active.port}`);

  const router = createRouter({ resolveTargetPort: () => active.port });
  await new Promise<void>((resolve, reject) => {
    router.once("error", reject);
    router.listen(port, "127.0.0.1", () => resolve());
  });
  log.info(`supervisor router listening on 127.0.0.1:${port}`);

  let promoting = false;
  const promote = async () => {
    if (promoting) {
      return;
    }
    promoting = true;
    try {
      const candidatePort = active.port === activePort ? passivePort : activePort;
      passive = await startWorker(candidatePort);
      await waitForPort(passive.port, healthTimeoutMs);
      const oldActive = active;
      active = passive;
      passive = oldActive;
      log.info(`promoted worker on port ${active.port}; draining old worker ${oldActive.port}`);
      setTimeout(() => {
        if (!passive) {
          return;
        }
        stopWorker(passive);
        setTimeout(() => {
          if (passive) {
            stopWorker(passive, true);
            passive = null;
          }
        }, 2_000);
      }, drainMs);
    } catch (err) {
      log.error(`promotion failed: ${String(err)}`);
      if (passive) {
        stopWorker(passive, true);
        passive = null;
      }
    } finally {
      promoting = false;
    }
  };

  const shutdown = async () => {
    watcher?.close();
    if (watchDebounceTimer) {
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = null;
    }
    router.close();
    stopWorker(active);
    if (passive) {
      stopWorker(passive);
    }
    setTimeout(() => {
      stopWorker(active, true);
      if (passive) {
        stopWorker(passive, true);
      }
      defaultRuntime.exit(0);
    }, 1500);
  };

  process.on("SIGUSR1", () => {
    void promote();
  });
  let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(CONFIG_PATH, () => {
      if (watchDebounceTimer) {
        clearTimeout(watchDebounceTimer);
      }
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = null;
        void promote();
      }, 500);
    });
  } catch (err) {
    log.warn(`config watcher disabled: ${String(err)}`);
  }
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

export function addGatewaySupervisorCommand(parent: Command): Command {
  const supervisor = parent.command("supervisor").description("Run gateway supervisor/router");
  supervisor
    .command("run")
    .description("Run blue/green gateway supervisor with a stable public port")
    .option("--port <port>", "Public gateway router port")
    .option("--active-port <port>", "Initial active worker port")
    .option("--passive-port <port>", "Passive worker port used for promotions")
    .option("--health-timeout-ms <ms>", "Worker startup health timeout")
    .option("--drain-ms <ms>", "Drain window before stopping previous worker")
    .option("--force", "Kill existing listeners on router/worker ports before start", false)
    .action(async (cmdOpts, command) => {
      await runGatewaySupervisorCommand(resolveSupervisorRunOptions(cmdOpts, command));
    });
  return supervisor;
}
