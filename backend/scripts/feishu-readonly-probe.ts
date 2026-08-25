import { readFeishu } from '../src/connectors/feishu';

async function main() {
  const result = await readFeishu({ allowlist: [], p2pEnabled: false, timeoutMs: 15000 });
  console.log(
    JSON.stringify({
      ok: result.ok,
      identity: result.identity,
      itemsSeen: result.itemsSeen,
      errorCode: result.errorCode || null,
      extra: {
        tokenStatus: result.extra?.tokenStatus,
        chatCount: result.extra?.chatCount,
        allowlistCount: result.extra?.allowlistCount,
        p2pEnabled: result.extra?.p2pEnabled,
      },
    })
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
