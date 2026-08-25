import { useEffect, useRef } from 'react';

const MAX_X = 2.5;
const MAX_Y = 2;

function canHoverFollow(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** Generic open-source mascot. Replace this component with your own brand avatar if desired. */
export default function AvatarMascot() {
  const rootRef = useRef<HTMLButtonElement>(null);
  const leftRef = useRef<SVGGElement>(null);
  const rightRef = useRef<SVGGElement>(null);
  const rafRef = useRef(0);
  const targetRef = useRef({ x: 0, y: 0 });
  const starTimerRef = useRef(0);

  useEffect(() => {
    const button = rootRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!button || !left || !right) return;
    const current = { x: 0, y: 0 };
    const apply = (x: number, y: number) => {
      const transform = `translate(${x} ${y})`;
      left.setAttribute('transform', transform);
      right.setAttribute('transform', transform);
    };
    const tick = () => {
      current.x += (targetRef.current.x - current.x) * 0.28;
      current.y += (targetRef.current.y - current.y) * 0.28;
      apply(current.x, current.y);
      const moving = Math.abs(current.x - targetRef.current.x) > 0.02
        || Math.abs(current.y - targetRef.current.y) > 0.02;
      rafRef.current = moving ? requestAnimationFrame(tick) : 0;
    };
    const queue = (x: number, y: number) => {
      targetRef.current = { x, y };
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      if (!canHoverFollow()) return;
      const rect = button.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / Math.max(24, rect.width)));
      const ny = Math.max(-1, Math.min(1, (event.clientY - rect.top - rect.height / 2) / Math.max(24, rect.height)));
      queue(nx * MAX_X, ny * MAX_Y);
    };
    const reset = () => queue(0, 0);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', reset);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.clearTimeout(starTimerRef.current);
    };
  }, []);

  const sparkle = () => {
    const element = rootRef.current;
    if (!element) return;
    element.classList.remove('is-star-active');
    void element.offsetWidth;
    element.classList.add('is-star-active');
    window.clearTimeout(starTimerRef.current);
    starTimerRef.current = window.setTimeout(
      () => element.classList.remove('is-star-active'),
      prefersReducedMotion() ? 300 : 780,
    );
  };

  return (
    <button
      ref={rootRef}
      type="button"
      className="avatar-mascot"
      aria-label="工作台头像，点击触发星星眼"
      onClick={sparkle}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <rect x="5" y="5" width="90" height="90" fill="#FFD12E" stroke="#111" strokeWidth="5" />
        <path d="M27 29h46l10 14v34H17V43z" fill="#fff" stroke="#111" strokeWidth="5" />
        <path d="M30 29v-9h40v9M22 55h56" fill="none" stroke="#111" strokeWidth="5" />
        <g ref={leftRef}>
          <rect x="29" y="44" width="15" height="13" fill="#111" />
          <path className="avatar-star avatar-star--left" d="M36.5 42l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#FF5A1F" />
        </g>
        <g ref={rightRef}>
          <rect x="56" y="44" width="15" height="13" fill="#111" />
          <path className="avatar-star avatar-star--right" d="M63.5 42l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#FF5A1F" />
        </g>
        <path d="M38 69h24" stroke="#111" strokeWidth="5" />
      </svg>
    </button>
  );
}
