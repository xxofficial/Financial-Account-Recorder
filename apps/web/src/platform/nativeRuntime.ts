import { Capacitor, registerPlugin } from '@capacitor/core';

type NativeMarketPlugin = {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    charset?: string;
  }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
};

type NativeInboxPlugin = {
  listPending(): Promise<{ items: NativeInboxItem[] }>;
  markHandled(options: { id: string; status: 'IMPORTED' | 'DUPLICATE' | 'FAILED'; message?: string }): Promise<void>;
};

type NativeDocumentPlugin = {
  extractPdfText(options: { path: string; password?: string; passwordKey?: string }): Promise<{ text: string; isEmpty: boolean }>;
};

type SecureSecretPlugin = {
  has(options: { key: string }): Promise<{ exists: boolean }>;
  set(options: { key: string; value: string }): Promise<void>;
  clear(options: { key: string }): Promise<void>;
};

export type NativeAppUpdate = {
  currentVersionName: string;
  currentVersionCode: number;
  latestVersionName?: string;
  latestVersionCode?: number;
  assetName?: string;
  downloadUrl?: string;
  releaseUrl?: string;
  hasUpdate: boolean;
  message?: string;
};

type NativeAppUpdatePlugin = {
  check(): Promise<NativeAppUpdate>;
  downloadAndInstall(options: { downloadUrl: string; assetName: string }): Promise<{ started: boolean; message: string }>;
};

export type NativeEmailSyncConfig = {
  mailboxId: string;
  provider: 'ZHUORUI' | 'SCHWAB';
  imapHost: string;
  imapPort: number;
  account: string;
  folder: string;
  autoSync: boolean;
  passwordConfigured: boolean;
  lastSyncAt: number;
  lastStatus: string;
};

type NativeEmailSyncPlugin = {
  configure(options: Omit<NativeEmailSyncConfig, 'mailboxId' | 'passwordConfigured' | 'lastSyncAt' | 'lastStatus'> & { mailboxId?: string; password?: string }): Promise<NativeEmailSyncConfig>;
  syncNow(options: { mailboxId: string }): Promise<{
    scannedCount: number;
    queuedCount: number;
    duplicateCount: number;
    ignoredCount: number;
    latestSeenAt: number;
    message: string;
  }>;
  status(): Promise<{ configs: NativeEmailSyncConfig[]; logs: Array<{ id: string; provider: string; level: string; message: string; createdAt: number }> }>;
  disable(options: { mailboxId: string }): Promise<void>;
  remove(options: { mailboxId: string }): Promise<void>;
};

export type NativeInboxItem = {
  id: string;
  source: 'EMAIL' | 'PDF' | 'SHARED_TEXT' | string;
  platform: string;
  externalReference?: string | null;
  payload: string;
  receivedAt: number;
  status: 'PENDING' | 'IMPORTED' | 'DUPLICATE' | 'FAILED';
  message?: string | null;
};

export const isAndroidNativeRuntime = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const nativeInbox = registerPlugin<NativeInboxPlugin>('NativeInbox');
export const nativeDocument = registerPlugin<NativeDocumentPlugin>('DocumentText');
export const nativeSecret = registerPlugin<SecureSecretPlugin>('SecureSecret');
export const nativeEmailSync = registerPlugin<NativeEmailSyncPlugin>('EmailSync');
export const nativeAppUpdate = registerPlugin<NativeAppUpdatePlugin>('AppUpdate');
const nativeMarket = registerPlugin<NativeMarketPlugin>('NativeMarket');

export const nativeSecretKeyForProvider = (provider: 'itick' | 'twelvedata' | 'marketdata') => `market_${provider}_api_key`;
export const nativeSecretKeyForStatement = (platform: string) => `statement_pdf_password_${platform}`;
export const nativeSecretPlaceholder = (provider: 'itick' | 'twelvedata' | 'marketdata') =>
  `__RECORDER_SECRET_${nativeSecretKeyForProvider(provider)}__`;

function toHeadersRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

/**
 * Android bypasses WebView CORS through a narrowly scoped native transport.
 * Web continues to use standard browser fetch, preserving its privacy model.
 */
export async function marketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isAndroidNativeRuntime()) return fetch(input, init);
  const request = input instanceof Request ? input : undefined;
  const url = request?.url ?? String(input);
  const response = await nativeMarket.request({
    url,
    method: init?.method ?? request?.method ?? 'GET',
    headers: toHeadersRecord(init?.headers ?? request?.headers),
    timeoutMs: 20_000,
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export async function nativeMarketFetch(url: string, options?: {
  headers?: Record<string, string>;
  charset?: string;
  timeoutMs?: number;
}): Promise<Response> {
  if (!isAndroidNativeRuntime()) return fetch(url, { headers: options?.headers });
  const response = await nativeMarket.request({
    url,
    headers: options?.headers,
    charset: options?.charset,
    timeoutMs: options?.timeoutMs ?? 15_000,
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}
