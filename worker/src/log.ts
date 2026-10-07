// Structured JSON logger. One line per call, written to stdout or stderr.
// Sensitive fields (cookie values, tokens, passwords) must never be passed in
// `fields`. The logger does not filter them — callers are responsible.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [k: string]: unknown;
}

const REDACT_KEYS = new Set(['value', 'token', 'password', 'cookie', 'set-cookie', 'authorization']);

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as LogFields);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...redact(fields),
  };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({
      ts: entry.ts,
      level: 'error',
      msg: 'log_serialize_failed',
      originalMsg: msg,
    });
  }
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const debug = (msg: string, f?: LogFields) => log('debug', msg, f);
export const info  = (msg: string, f?: LogFields) => log('info',  msg, f);
export const warn  = (msg: string, f?: LogFields) => log('warn',  msg, f);
export const error = (msg: string, f?: LogFields) => log('error', msg, f);