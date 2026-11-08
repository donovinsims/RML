import { sleep } from "./core.mjs";

export class FetchError extends Error {
  constructor(message, { url, status = null, code = "FETCH_ERROR", retryable = false } = {}) {
    super(message);
    this.name = "FetchError";
    this.url = url;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FetchError(`Response for ${response.url} declares ${declared} bytes, above the ${maxBytes}-byte limit.`, {
      url: response.url,
      status: response.status,
      code: "BODY_TOO_LARGE",
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchError(`Response for ${response.url} exceeded the ${maxBytes}-byte limit.`, {
        url: response.url,
        status: response.status,
        code: "BODY_TOO_LARGE",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Bounded HTTP client with a global request gate, per-request deadline, retry
 * budget, and response size cap. It never authenticates or sends form data.
 */
export function createFetcher({
  timeoutMs = 15_000,
  retries = 1,
  delayMs = 0,
  userAgent = "RMLBenchmark/1.0",
  maxBytes = 5_000_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  let chain = Promise.resolve();
  let lastStartedAt = 0;
  let requestCount = 0;

  function throttle() {
    const scheduled = chain.then(async () => {
      const wait = lastStartedAt + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStartedAt = Date.now();
    });
    chain = scheduled.catch(() => {});
    return scheduled;
  }

  async function attempt(url, { method = "GET", headers = {}, maxBytesOverride } = {}) {
    const limit = maxBytesOverride || maxBytes;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await throttle();
      requestCount += 1;
      const response = await fetchImpl(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          ...headers,
        },
      });
      const body = await readLimited(response, limit);
      return {
        status: response.status,
        finalUrl: response.url || url,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(url, options = {}) {
    let lastError;
    for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
      try {
        const result = await attempt(url, options);
        if (RETRYABLE_STATUS.has(result.status) && attemptIndex < retries) {
          await sleep(200 * (attemptIndex + 1));
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        const retryable = error.name === "AbortError" || error.code === "ECONNRESET" || error.code === "UND_ERR_SOCKET";
        if (!retryable || attemptIndex >= retries) break;
        await sleep(250 * (attemptIndex + 1));
      }
    }
    if (lastError?.name === "AbortError") {
      throw new FetchError(`Request to ${url} exceeded ${timeoutMs}ms.`, { url, code: "TIMEOUT", retryable: true });
    }
    throw lastError instanceof FetchError
      ? lastError
      : new FetchError(lastError?.message || `Request to ${url} failed.`, { url, code: "NETWORK_ERROR", retryable: true });
  }

  async function text(url, options = {}) {
    const result = await request(url, options);
    if (result.status >= 400) {
      throw new FetchError(`HTTP ${result.status} for ${url}.`, { url, status: result.status, code: "HTTP_ERROR" });
    }
    return result.body.toString("utf8");
  }

  return {
    request,
    text,
    get requestCount() {
      return requestCount;
    },
  };
}

/** Robots and sitemaps are optional evidence; failures are recorded by callers. */
export async function fetchOptionalText(fetcher, url, options = {}) {
  try {
    const response = await fetcher.request(url, options);
    if (response.status >= 400) return { available: false, status: response.status, text: null, finalUrl: response.finalUrl };
    return { available: true, status: response.status, text: response.body.toString("utf8"), finalUrl: response.finalUrl };
  } catch (error) {
    return { available: false, status: null, text: null, error: error.message, code: error.code };
  }
}
