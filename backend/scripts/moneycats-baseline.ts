import '../src/bootstrapEnv';
import { relative, resolve } from 'node:path';
import {
  defaultMoneyCatsSyncPaths,
  runMoneyCatsSync,
} from '../src/finance/moneyCatsSync.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const defaults = defaultMoneyCatsSyncPaths();
const output = readArg('--output') || defaults.currentOutput;
const result = await runMoneyCatsSync({
  trigger: readArg('--trigger') || 'manual',
  asOf: readArg('--as-of'),
  paths: {
    source: readArg('--db') || defaults.source,
    currentOutput: output,
  },
});

process.stdout.write(`${JSON.stringify({
  status: result.run.status,
  asOf: result.run.asOf,
  rowsRead: result.run.rowsRead,
  output: relative(resolve(import.meta.dirname, '..'), output),
})}\n`);
