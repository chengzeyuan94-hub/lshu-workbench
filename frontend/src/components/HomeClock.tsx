import { useEffect, useState } from 'react';
import { formatHomeClock, systemTimeZone } from '../lib/homeClock';

export default function HomeClock({ locationLabel }: { locationLabel?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const clock = formatHomeClock(now, systemTimeZone());

  return (
    <section className="home-clock-panel" aria-label="当前时间">
      <div className="ui-page-kicker">CLK · LOCAL TIME</div>
      <time className="home-clock-time" dateTime={clock.iso}>
        <span className="home-clock-hhmm">{clock.hhmm}</span>
        <span className="home-clock-sec" aria-hidden="true">{clock.seconds}</span>
      </time>
      <div className="home-clock-date">
        <span>{clock.date}</span>
        <span>{clock.weekday}</span>
      </div>
      <div className="home-clock-zone">{locationLabel || '本机时间'}</div>
      <span className="sr-only">系统时区 {clock.timeZone}</span>
    </section>
  );
}
