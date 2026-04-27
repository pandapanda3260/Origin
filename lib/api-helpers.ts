import { NextResponse } from 'next/server';

export function jsonOk<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, { status: 200, ...init });
}

export function jsonError(detail: string, status = 400) {
  return NextResponse.json({ detail }, { status });
}

export const noStoreHeaders = {
  'cache-control': 'no-store, no-cache, must-revalidate',
};
