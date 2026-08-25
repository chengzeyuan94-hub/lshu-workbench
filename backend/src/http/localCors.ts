export const LOCAL_FRONTEND_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5180',
  'http://127.0.0.1:5180',
  `http://localhost:${process.env.PORT || '3456'}`,
  `http://127.0.0.1:${process.env.PORT || '3456'}`,
]);
export const BIND_HOST = '127.0.0.1';

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return LOCAL_FRONTEND_ORIGINS.has(origin);
}

export function corsOriginDelegate(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
): void {
  if (isAllowedCorsOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error('CORS origin denied'));
}
