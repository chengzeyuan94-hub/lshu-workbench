import { spawn } from 'node:child_process';
import { childEnv } from '../config/childEnv';

export interface RunArgvOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunArgvResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export type ArgvRunner = (argv: string[], options?: RunArgvOptions) => Promise<RunArgvResult>;

export async function runArgv(argv: string[], options: RunArgvOptions = {}): Promise<RunArgvResult> {
  if (!argv.length || !argv[0]) {
    throw new Error('runArgv requires an executable path');
  }
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const [command, ...args] = argv;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 800);
    }, timeoutMs);

    const append = (buf: Buffer, kind: 'stdout' | 'stderr') => {
      const next = (kind === 'stdout' ? stdoutBytes : stderrBytes) + buf.length;
      if (next > maxBytes) {
        truncated = true;
        const remain = Math.max(0, maxBytes - (kind === 'stdout' ? stdoutBytes : stderrBytes));
        const slice = remain > 0 ? buf.subarray(0, remain).toString('utf8') : '';
        if (kind === 'stdout') {
          stdout += slice;
          stdoutBytes = maxBytes;
        } else {
          stderr += slice;
          stderrBytes = maxBytes;
        }
        child.kill('SIGTERM');
        return;
      }
      const text = buf.toString('utf8');
      if (kind === 'stdout') {
        stdout += text;
        stdoutBytes = next;
      } else {
        stderr += text;
        stderrBytes = next;
      }
    };

    child.stdout.on('data', (buf: Buffer) => append(buf, 'stdout'));
    child.stderr.on('data', (buf: Buffer) => append(buf, 'stderr'));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, truncated });
    });
  });
}
