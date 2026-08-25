import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { childEnv, isSensitiveEnvName } from '../src/config/childEnv';
import { assertSettingsPatch, isSecretLikeFieldName, publicSettings, SettingsPolicyError } from '../src/config/settingsPolicy';
import { isAllowedCorsOrigin, BIND_HOST } from '../src/http/localCors';
import { ensurePrivateDir, ensurePrivateFile, modeOf } from '../src/config/filePermissions';
import { migrateProductivityV2 } from '../src/productivitySchema';
import { migrateProductivityV3, backupSqliteThenVerify } from '../src/productivitySchemaV3';

describe('隐私与 API 边界', () => {
  it('settings 拒绝 secret-like 字段', () => {
    expect(isSecretLikeFieldName('deepseekApiKey')).toBe(true);
    expect(isSecretLikeFieldName('aiAnalysisEnabled')).toBe(false);
    expect(() => assertSettingsPatch({ DEEPSEEK_API_KEY: 'x' })).toThrow(SettingsPolicyError);
    expect(() => assertSettingsPatch({ unknownField: true })).toThrow(SettingsPolicyError);
    const allowed = assertSettingsPatch({ aiAnalysisEnabled: true, confirmAiUpload: true });
    expect(allowed).toEqual({ aiAnalysisEnabled: true });
    expect(allowed).not.toHaveProperty('confirmAiUpload');
  });

  it('public settings 不泄露未知 DB key', () => {
    const fakeApiKey = ['sk', 'abcdefghijklmnop'].join('-');
    const pub = publicSettings({ scanRoot: '/x', leakedSecret: fakeApiKey, aiAnalysisEnabled: false }, { scanRoot: '/d', privacyNotice: 'n' });
    expect(pub).not.toHaveProperty('leakedSecret');
    expect(JSON.stringify(pub)).not.toContain('sk-');
  });

  it('CORS 仅本机前端 origin', () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true);
    expect(isAllowedCorsOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedCorsOrigin('http://evil.example')).toBe(false);
    expect(BIND_HOST).toBe('127.0.0.1');
  });

  it('child env 不含 KEY/TOKEN', () => {
    const fakeApiKey = ['sk', 'abcdefghijklmnop'].join('-');
    const env = childEnv({ PATH: '/bin', DEEPSEEK_API_KEY: fakeApiKey, HOME: '/tmp', FOO_TOKEN: 'abc' });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.FOO_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(isSensitiveEnvName('CIMIDATA_APP_SECRET')).toBe(true);
  });

  it('新建目录/文件权限 0700/0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-perm-'));
    const nested = join(dir, 'data');
    ensurePrivateDir(nested);
    const file = join(nested, 'workbench.db');
    writeFileSync(file, 'x');
    ensurePrivateFile(file);
    expect(modeOf(nested)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('V3 迁移兼容', () => {
  it('重复 evidence 先兼容再建唯一索引；不删除用户待办', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-v3mig-'));
    const db = new Database(join(dir, 'old.db'));
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source_path TEXT NOT NULL, cluster TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium', reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    db.prepare(`INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at) VALUES ('a','p','c','low','','pending','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO todos (title, source_path, cluster, priority, reason, status, created_at, updated_at) VALUES ('b','p2','c','low','','confirmed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    migrateProductivityV2(db);
    db.prepare(`INSERT INTO todo_source_evidence (todo_id, source_type, fingerprint, evidence_type, summary, occurred_at, payload_json, created_at)
      VALUES (1,'feishu_message','fp','inferred','s','2026-01-01T00:00:00.000Z','{}','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO todo_source_evidence (todo_id, source_type, fingerprint, evidence_type, summary, occurred_at, payload_json, created_at)
      VALUES (1,'feishu_message','fp','inferred','s','2026-01-01T00:00:00.000Z','{}','2026-01-01T00:00:00.000Z')`).run();
    const counts = migrateProductivityV3(db);
    expect(counts.duplicateEvidence).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).toEqual({ n: 2 });
    const confirmed = db.prepare(`SELECT lifecycle_status FROM todos WHERE status='confirmed'`).get() as { lifecycle_status: string };
    expect(confirmed.lifecycle_status).toBe('confirmed');
    const bak = join(dir, 'bak.db');
    backupSqliteThenVerify(db, bak);
    expect(existsSync(bak)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
