/**
 * Local diagnostic helper: enable allow-all Feishu reads dynamically.
 * Does not hardcode chat IDs. Does not print chat IDs or message bodies.
 */
import { readFeishu } from '../src/connectors/feishu';
import { updateSettings } from '../src/db';

async function main() {
  updateSettings({
    feishuAllowAll: true,
    feishuP2pEnabled: true,
  });

  const result = await readFeishu({
    allowAll: true,
    p2pEnabled: true,
    timeoutMs: 20_000,
  });

  const messageCount = result.items.filter((item) => item.sourceType === 'feishu_message').length;
  const eventCount = result.items.filter((item) => item.sourceType === 'feishu_calendar').length;

  console.log(
    JSON.stringify({
      ok: result.ok,
      identity: result.identity,
      chatsVisible: result.extra?.chatCount ?? 0,
      chatsRead: result.extra?.chatsRead ?? 0,
      chatsFailed: result.extra?.chatsFailed ?? 0,
      messagesSeen: messageCount,
      calendarEvents: eventCount,
      errorCode: result.errorCode ?? null,
      writeFeishu: false,
      note: 'messages were counted only; no AI upsert and no chat IDs printed',
    })
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'failed');
  process.exit(1);
});
