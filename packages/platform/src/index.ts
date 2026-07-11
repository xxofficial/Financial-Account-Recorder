import type { NativeImportCandidate } from '@recoder/contracts';

export interface PlatformCapabilities {
  runtime: 'web' | 'android';
  supportsNativeHttp: boolean;
  supportsPdfShare: boolean;
  supportsEmailSync: boolean;
  supportsSecureSecrets: boolean;
}

export interface DocumentPort {
  pickPdf(): Promise<{ name: string; text: string }>;
  listSharedDocuments(): Promise<Array<{ id: string; name: string; text: string }>>;
  markSharedDocumentConsumed(id: string): Promise<void>;
}

export interface EmailSyncPort {
  getStatus(): Promise<{ configured: boolean; scheduled: boolean; message?: string }>;
  triggerManualSync(): Promise<void>;
  setScheduled(enabled: boolean): Promise<void>;
  listPendingImports(): Promise<NativeImportCandidate[]>;
  markImportHandled(id: string, status: 'IMPORTED' | 'DUPLICATE' | 'FAILED'): Promise<void>;
}

export interface SecretPort {
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface HttpTransport {
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface PlatformServices {
  capabilities: PlatformCapabilities;
  documents: DocumentPort;
  emailSync: EmailSyncPort;
  secrets: SecretPort;
  http: HttpTransport;
}

class UnsupportedEmailSyncPort implements EmailSyncPort {
  async getStatus() { return { configured: false, scheduled: false, message: '当前平台不支持邮件后台同步' }; }
  async triggerManualSync() { throw new Error('当前平台不支持邮件后台同步'); }
  async setScheduled() { throw new Error('当前平台不支持邮件后台同步'); }
  async listPendingImports() { return []; }
  async markImportHandled() { /* no-op */ }
}

class BrowserDocumentPort implements DocumentPort {
  async pickPdf(): Promise<{ name: string; text: string }> {
    throw new Error('PDF 文本提取器尚未加载');
  }
  async listSharedDocuments() { return []; }
  async markSharedDocumentConsumed() { /* no-op */ }
}

class BrowserSecretPort implements SecretPort {
  private readonly prefix = 'recoder-secret-presence:';
  async has(key: string) { return localStorage.getItem(`${this.prefix}${key}`) === '1'; }
  async set(key: string, value: string) {
    // Web 明文由 app-data 的 IndexedDB SecretStore 保存；这里仅保存存在性标记。
    if (!value) throw new Error('密钥不能为空');
    localStorage.setItem(`${this.prefix}${key}`, '1');
  }
  async clear(key: string) { localStorage.removeItem(`${this.prefix}${key}`); }
}

export const browserPlatformServices: PlatformServices = {
  capabilities: {
    runtime: 'web',
    supportsNativeHttp: false,
    supportsPdfShare: false,
    supportsEmailSync: false,
    supportsSecureSecrets: false,
  },
  documents: new BrowserDocumentPort(),
  emailSync: new UnsupportedEmailSyncPort(),
  secrets: new BrowserSecretPort(),
  http: { request: (input, init) => fetch(input, init) },
};
