import { spawn } from "node:child_process";
import { extname } from "node:path";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_RUNTIME_MS = 5 * 60 * 1000;

export interface CliLaunchTarget {
  executable: string;
  prefix: string[];
}

export interface CliRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Node/tsx need their script path before ct's argv; a compiled Bun executable invokes itself. */
export function resolveCliLaunchTarget(
  execPath: string = process.execPath,
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): CliLaunchTarget {
  const entry = argv[1];
  const extension = entry ? extname(entry).toLowerCase() : "";
  const runtimeEntry = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension);
  return {
    executable: execPath,
    prefix: runtimeEntry && entry ? [...execArgv, entry] : [],
  };
}

export interface RunCliOptions {
  cwd: string;
  target?: CliLaunchTarget;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Execute the current ct entrypoint without a shell and capture bounded output. */
export function runCli(argv: readonly string[], options: RunCliOptions): Promise<CliRunResult> {
  const target = options.target ?? resolveCliLaunchTarget();
  const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(target.executable, [...target.prefix, ...argv], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, limit - stdout.length - stderr.length);
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? MAX_RUNTIME_MS);
    timeout.unref?.();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
      });
    });
  });
}
