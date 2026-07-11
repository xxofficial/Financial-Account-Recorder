export interface SecretStore {
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  clear(key: string): Promise<void>;
}

/**
 * 数据层只暴露契约；Web 实现由 Dexie，Android 实现由 Keystore 插件提供。
 * 这样任何业务代码都不会直接依赖本地存储的具体技术。
 */
