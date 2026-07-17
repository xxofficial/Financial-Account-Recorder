import { describe, expect, it } from 'vitest';
import { userFacingError, userFacingSyncDetail } from '../shared/userMessages';

describe('用户可见错误文案', () => {
  it('将网络错误转换为可操作提示', () => {
    expect(userFacingError(new Error('Failed to fetch'), 'sync')).toContain('检查网络');
    expect(userFacingSyncDetail(new Error('Failed to fetch'))).toBe('网络连接失败');
  });

  it('不把跨域和额度原文直接展示给用户', () => {
    expect(userFacingError(new Error('CORS blocked'), 'sync')).toContain('暂不支持');
    expect(userFacingError(new Error('rate limit exceeded'), 'sync')).toContain('访问额度');
  });

  it('将行情源超时和空响应转换为用户可理解的状态', () => {
    expect(userFacingSyncDetail(new Error('stock-sdk 请求超时'))).toBe('网络请求超时');
    expect(userFacingSyncDetail(new Error('US 日K响应为空'))).toBe('行情源未返回数据');
  });
});
