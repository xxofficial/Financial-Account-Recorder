export type UserErrorContext = 'sync' | 'import' | 'backup' | 'save' | 'delete' | 'load';

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/** Convert transport/provider errors into actionable user-facing text. */
export function userFacingError(error: unknown, context: UserErrorContext): string {
  const message = rawMessage(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('failed to fetch') || normalized.includes('networkerror') || normalized.includes('network error')) {
    return context === 'sync'
      ? '暂时无法连接行情服务，请检查网络后重试。'
      : '暂时无法连接服务，请检查网络后重试。';
  }
  if (normalized.includes('cors') || normalized.includes('跨域')) {
    return '当前网页无法访问该数据源，已标记为暂不支持；可稍后重试或查看其他数据源。';
  }
  if (normalized.includes('quota') || normalized.includes('rate limit') || normalized.includes('额度')) {
    return '数据源暂时达到访问额度，请稍后重试。';
  }
  if (context === 'import') return '导入失败，请检查文件格式、密码和内容后重试。';
  if (context === 'backup') return '备份操作失败，请检查文件并重试。';
  if (context === 'delete') return '删除失败，原有数据未改变，请重试。';
  if (context === 'save') return '保存失败，请检查输入内容后重试。';
  if (context === 'load') return '读取失败，请重试或恢复最近一次备份。';
  return '操作失败，请稍后重试。';
}

export function userFacingSyncDetail(error: unknown): string {
  const message = rawMessage(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('failed to fetch') || normalized.includes('network')) return '网络连接失败';
  if (normalized.includes('timeout') || normalized.includes('超时')) return '网络请求超时';
  if (normalized.includes('cors') || normalized.includes('跨域')) return '网页无法访问数据源';
  if (normalized.includes('quota') || normalized.includes('rate limit') || normalized.includes('额度')) return '数据源访问额度已用尽';
  if (normalized.includes('日k响应为空') || normalized.includes('no data') || normalized.includes('empty_data')) return '行情源未返回数据';
  if (normalized.includes('stock-sdk')) return '行情源暂时不可用';
  return message || '未知原因';
}
