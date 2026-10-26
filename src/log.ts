/**
 * stdout is the MCP wire. Everything human-readable goes to stderr, always.
 */
const PREFIX = '[meatsack]';

function write(level: string, args: unknown[]): void {
  const line = args
    .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(`${PREFIX} ${level} ${line}\n`);
}

export const log = {
  info: (...args: unknown[]) => write('·', args),
  warn: (...args: unknown[]) => write('!', args),
  error: (...args: unknown[]) => write('✖', args),
};
