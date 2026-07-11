import { db } from '../../db/localDb';
import { MarketRequestStatus, MarketRequestLogType } from '../../db/schema';
export { marketFetch } from '../../platform/nativeRuntime';

export interface MarketDataResult<T> {
  ok: boolean;
  status: MarketRequestStatus;
  provider: string;
  data?: T;
  message?: string;
  errorCode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  nextRetryAt?: number;
  fromCache?: boolean;
  durationMs?: number;
  response?: Response;
}

export async function logMarketRequest(log: {
  providerId?: string;
  type: MarketRequestLogType;
  workItemIds?: string[];
  message: string;
  detail?: any;
}): Promise<number | undefined> {
  try {
    const id = await db.marketRequestLogs.add({
      ...log,
      createdAt: Date.now()
    });
    return id;
  } catch (err) {
    console.error('Failed to write market request log:', err);
    return undefined;
  }
}

export async function requestWithLogging<T>(
  provider: string,
  requestType: 'quote' | 'search' | 'history',
  symbol: string,
  market: string,
  assetType: string,
  endpoint: string,
  timeoutMs: number,
  executeRequest: (signal: AbortSignal) => Promise<{ response: Response; parseData: (resp: Response) => Promise<T> }>,
  workItemIds?: string[]
): Promise<MarketDataResult<T>> {
  const startedAt = Date.now();
  
  // 1. Write the initial start log to DB
  try {
    await logMarketRequest({
      providerId: provider,
      type: 'request_start',
      workItemIds,
      message: `[${provider}] 发起 ${requestType} 请求 (${symbol}, ${market})`,
      detail: { endpoint, assetType }
    });
  } catch (err) {
    console.error('Failed to log request start:', err);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let finalStatus: MarketRequestStatus = 'failed';
  let message = '请求未完成';
  let errorCode = 'UNKNOWN';
  let httpStatus = 0;
  let retryAfterMs = 0;
  let nextRetryAt = 0;
  let resultData: T | undefined;
  let rawResponse: Response | undefined;

  try {
    const { response, parseData } = await executeRequest(controller.signal);
    clearTimeout(timer);
    rawResponse = response;
    httpStatus = response.status;

    // Detect rate limit via headers
    if (response.headers && typeof response.headers.get === 'function') {
      const retryAfterHeader = response.headers.get('Retry-After');
      if (retryAfterHeader) {
        const parsedRetry = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedRetry)) {
          retryAfterMs = parsedRetry * 1000;
          nextRetryAt = Date.now() + retryAfterMs;
        }
      }
      const remainingHeader = response.headers.get('X-RateLimit-Remaining');
      const resetHeader = response.headers.get('X-RateLimit-Reset');
      if (resetHeader && remainingHeader && parseInt(remainingHeader, 10) === 0) {
        const parsedReset = parseInt(resetHeader, 10);
        if (!isNaN(parsedReset)) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (parsedReset > nowSec) {
            retryAfterMs = (parsedReset - nowSec) * 1000;
          } else {
            retryAfterMs = parsedReset * 1000;
          }
          nextRetryAt = Date.now() + retryAfterMs;
        }
      }
    }

    // Check status or parse body
    if (response.status === 429) {
      finalStatus = 'rate_limited';
      message = '此行情源的 API 请求触发了频控额度限制，请稍后再试。';
      errorCode = 'RATE_LIMIT_EXCEEDED';
    } else if (response.ok) {
      let text = '';
      if (typeof response.clone === 'function') {
        try {
          const responseClone = response.clone();
          text = await responseClone.text();
        } catch (e) {
          console.warn('Failed to clone response for text analysis:', e);
        }
      } else if (typeof response.text === 'function') {
        try {
          text = await response.text();
        } catch (e) {
          console.warn('Failed to read response text:', e);
        }
      }
      const lowerText = text.toLowerCase();

      if (
        lowerText.includes('quota exceeded') ||
        lowerText.includes('rate limit exceeded') ||
        lowerText.includes('too many requests') ||
        lowerText.includes('limit reached') ||
        (provider === 'twelvedata' && lowerText.includes('api limit reached'))
      ) {
        finalStatus = 'rate_limited';
        message = '此行情源的 API 今日或当前频度额度已用尽。';
        errorCode = 'RATE_LIMIT_EXCEEDED';
        if (retryAfterMs === 0) {
          retryAfterMs = 60 * 1000;
          nextRetryAt = Date.now() + retryAfterMs;
        }
      } else if (
        provider === 'twelvedata' && jsonHasError(text)
      ) {
        finalStatus = 'failed';
        message = getTwelveDataError(text);
        errorCode = 'API_ERROR';
      } else if (
        provider === 'itick' && jsonHasItickError(text)
      ) {
        finalStatus = 'failed';
        message = getItickError(text);
        errorCode = 'API_ERROR';
      } else {
        try {
          resultData = await parseData(response);
          finalStatus = 'success';
          message = '请求成功';
        } catch (parseErr: any) {
          finalStatus = 'failed';
          message = `解析返回数据失败: ${parseErr.message || parseErr}`;
          errorCode = 'JSON_PARSE_ERROR';
        }
      }
    } else {
      finalStatus = 'failed';
      message = `服务器响应错误，HTTP 状态码: ${response.status}`;
      errorCode = 'HTTP_ERROR';
    }
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      finalStatus = 'timeout';
      message = `行情请求超时（限制 ${timeoutMs / 1000} 秒），已被系统中止。`;
      errorCode = 'TIMEOUT';
    } else if (err.message && err.message.toLowerCase().includes('failed to fetch')) {
      if (navigator.onLine === false) {
        finalStatus = 'network_error';
        message = '网络已断开，请检查您的网络连接。';
        errorCode = 'NETWORK_DISCONNECTED';
      } else {
        finalStatus = 'cors_error';
        message = '请求发生跨域 (CORS) 限制或目标行情服务器不可达。';
        errorCode = 'CORS_OR_NETWORK_ERROR';
      }
    } else {
      finalStatus = 'network_error';
      message = `网络请求发生异常: ${err.message || err}`;
      errorCode = 'NETWORK_ERROR';
    }
  }

  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;

  // 2. Write the end log to DB
  try {
    const isSuccess = finalStatus === 'success';
    await logMarketRequest({
      providerId: provider,
      type: isSuccess ? 'request_success' : (finalStatus === 'rate_limited' ? 'rate_limited' : 'request_failed'),
      workItemIds,
      message: `[${provider}] 请求结束: ${isSuccess ? '成功' : '失败 - ' + message}`,
      detail: {
        status: finalStatus,
        httpStatus,
        durationMs,
        errorCode,
        retryAfterMs
      }
    });
  } catch (logErr) {
    console.error('Failed to log request end:', logErr);
  }

  return {
    ok: finalStatus === 'success',
    status: finalStatus,
    provider,
    data: resultData,
    message,
    errorCode,
    httpStatus,
    retryAfterMs,
    nextRetryAt,
    durationMs,
    response: rawResponse
  };
}

function jsonHasError(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return parsed.status === 'error' || parsed.code !== undefined && parsed.code !== 200;
  } catch {
    return false;
  }
}

function getTwelveDataError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed.message || 'TwelveData API 错误';
  } catch {
    return 'TwelveData API 响应解析失败';
  }
}

function jsonHasItickError(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return parsed.code !== undefined && parsed.code !== 0;
  } catch {
    return false;
  }
}

function getItickError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed.msg || parsed.message || `iTick 错误码 ${parsed.code}`;
  } catch {
    return 'iTick API 响应解析失败';
  }
}
