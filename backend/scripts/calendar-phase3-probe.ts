import { executeWorkbenchCalendarWrite, TEST_EVENT_TITLE, listAppleCalendars } from '../src/connectors/appleCalendar';
import { WORKBENCH_CALENDAR_NAME } from '../src/connectors/types';

async function main() {
  const startAt = '2026-08-25T08:00:00.000Z';
  const endAt = '2026-08-25T08:30:00.000Z';

  const before = await listAppleCalendars({ timeoutMs: 25000 });
  const beforeNames = before.map((c) => c.name);
  console.log(
    JSON.stringify({
      step: 'before',
      hasWorkbench: beforeNames.includes(WORKBENCH_CALENDAR_NAME),
      protectedStill: ['个人', '工作', '家庭'].every((n) => beforeNames.includes(n)),
      count: beforeNames.length,
    })
  );

  const created = await executeWorkbenchCalendarWrite(
    'create',
    { title: TEST_EVENT_TITLE, startAt, endAt, confirmed: true },
    { timeoutMs: 30000 }
  );
  console.log(JSON.stringify({ step: 'created', eventId: created.eventId, calendarName: created.calendarName }));

  const found = await executeWorkbenchCalendarWrite(
    'find',
    { title: TEST_EVENT_TITLE, eventId: String(created.eventId || ''), confirmed: true },
    { timeoutMs: 30000 }
  );
  console.log(JSON.stringify({ step: 'found', found: found.found, eventId: found.eventId }));

  const deleted = await executeWorkbenchCalendarWrite(
    'delete',
    { title: TEST_EVENT_TITLE, eventId: String(created.eventId || ''), confirmed: true },
    { timeoutMs: 30000 }
  );
  console.log(JSON.stringify({ step: 'deleted', deleted: deleted.deleted, eventId: deleted.eventId }));

  const gone = await executeWorkbenchCalendarWrite(
    'find',
    { title: TEST_EVENT_TITLE, eventId: String(created.eventId || ''), confirmed: true },
    { timeoutMs: 30000 }
  );
  console.log(JSON.stringify({ step: 'afterDelete', found: gone.found }));

  const after = await listAppleCalendars({ timeoutMs: 25000 });
  const afterNames = after.map((c) => c.name);
  console.log(
    JSON.stringify({
      step: 'after',
      hasWorkbench: afterNames.includes(WORKBENCH_CALENDAR_NAME),
      protectedStill: ['个人', '工作', '家庭'].every((n) => afterNames.includes(n)),
      count: afterNames.length,
    })
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
