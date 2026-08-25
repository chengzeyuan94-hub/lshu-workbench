import { umask } from 'node:process';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Must be imported before db.ts or any module that creates files.
 * Sets a restrictive umask and loads backend/.env.local.
 */
umask(0o077);

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__moduleDir, '../.env.local'), quiet: true });
