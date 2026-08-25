import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopFileFingerprint, diffDesktopEntries, readDesktop } from '../src/connectors/desktop';
import { collectDesktopEntries } from '../src/scanner';

describe('桌面增量 fingerprint', () => {
  it('相同 path/mtime/size/摘要得到稳定 fingerprint', () => {
    const a = { path: '/tmp/a.md', size: 10, modifiedAt: '2026-08-24T00:00:00.000Z', text: 'hello world' };
    expect(desktopFileFingerprint(a)).toBe(desktopFileFingerprint({ ...a }));
    expect(desktopFileFingerprint({ ...a, size: 11 })).not.toBe(desktopFileFingerprint(a));
  });

  it('文件更新记 changed，消失记 disappeared，不能当完成', () => {
    const file = { path: '/tmp/work/a.md', name: 'a.md', type: 'md', size: 3, modifiedAt: '2026-08-24T00:00:00.000Z', text: 'abc', fingerprint: 'fp1' };
    const first = diffDesktopEntries([file], undefined, '2026-08-24T01:00:00.000Z');
    expect(first.items[0].status).toBe('open');
    const updated = { ...file, fingerprint: 'fp2', modifiedAt: '2026-08-24T02:00:00.000Z' };
    const second = diffDesktopEntries([updated], first.next, '2026-08-24T03:00:00.000Z');
    expect(second.items[0].status).toBe('changed');
    const third = diffDesktopEntries([], second.next, '2026-08-24T04:00:00.000Z');
    expect(third.items[0].status).toBe('disappeared');
    expect(third.items[0].payload.disappearedAt).toBeTruthy();
  });

  it('排除 node_modules / 构建产物 / 隐藏目录', () => {
    const root = join(tmpdir(), `wb-desk-${Date.now()}`);
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    mkdirSync(join(root, 'ok'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'a.md'), 'skip');
    writeFileSync(join(root, 'dist', 'b.md'), 'skip');
    writeFileSync(join(root, '.hidden', 'c.md'), 'skip');
    writeFileSync(join(root, 'ok', 'keep.md'), 'keep');
    const entries = collectDesktopEntries(root, { extraSkipDirs: ['dist'] });
    rmSync(root, { recursive: true, force: true });
    expect(entries.map((e) => e.name)).toEqual(['keep.md']);
    const result = readDesktop({
      rootDir: root,
      collect: () => entries,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
  });
});
