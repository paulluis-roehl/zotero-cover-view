const MAX_CONCURRENT_REQUESTS = 4;
const MAX_REQUESTS_PER_WINDOW = 90;
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 1;

export interface OpenLibraryResponse {
  status: number;
  bytes: Uint8Array;
}

interface RequestJob {
  url: string;
  resolve: (response: OpenLibraryResponse) => void;
  reject: (error: unknown) => void;
  rateLimitRetries: number;
}

const schedulerState = {
  activeRequests: 0,
  blockedUntil: 0,
};
const requestStarts: number[] = [];
const requestQueue: RequestJob[] = [];
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleWakeUp(delay: number): void {
  if (wakeTimer !== undefined) return;

  wakeTimer = setTimeout(() => {
    wakeTimer = undefined;
    pump();
  }, delay);
}

function pump(): void {
  const now = Date.now();
  while (
    requestStarts.length > 0 &&
    requestStarts[0] <= now - REQUEST_WINDOW_MS
  ) {
    requestStarts.shift();
  }

  if (requestQueue.length === 0) return;

  const quotaAvailableAt =
    requestStarts.length >= MAX_REQUESTS_PER_WINDOW
      ? requestStarts[0] + REQUEST_WINDOW_MS
      : now;
  const nextStartAt = Math.max(schedulerState.blockedUntil, quotaAvailableAt);
  if (nextStartAt > now) {
    scheduleWakeUp(nextStartAt - now);
    return;
  }

  while (
    requestQueue.length > 0 &&
    schedulerState.activeRequests < MAX_CONCURRENT_REQUESTS &&
    requestStarts.length < MAX_REQUESTS_PER_WINDOW
  ) {
    const job = requestQueue.shift()!;
    schedulerState.activeRequests++;
    requestStarts.push(Date.now());

    void runJob(job).finally(() => {
      schedulerState.activeRequests--;
      pump();
    });
  }
}

export function scheduleOpenLibraryRequest(
  url: string,
): Promise<OpenLibraryResponse> {
  return new Promise<OpenLibraryResponse>((resolve, reject) => {
    requestQueue.push({ url, resolve, reject, rateLimitRetries: 0 });
    pump();
  });
}

async function runJob(job: RequestJob): Promise<void> {
  try {
    const response = await requestOpenLibraryCover(job.url);
    if (response.status === 403 || response.status === 429) {
      if (job.rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
        job.reject(
          new Error(
            `Open Library rate limit persisted after retry (${response.status})`,
          ),
        );
        return;
      }

      job.rateLimitRetries++;
      schedulerState.blockedUntil = Math.max(
        schedulerState.blockedUntil,
        Date.now() + REQUEST_WINDOW_MS,
      );
      requestQueue.push(job);
      return;
    }
    job.resolve(response);
  } catch (error) {
    job.reject(error);
  }
}

async function requestOpenLibraryCover(
  url: string,
): Promise<OpenLibraryResponse> {
  const response = await Zotero.HTTP.request("GET", url, {
    headers: { Accept: "image/jpeg" },
    responseType: "arraybuffer",
    successCodes: [200, 403, 404, 429],
    timeout: 15_000,
    errorDelayMax: 0,
  });
  return {
    status: response.status,
    bytes: new Uint8Array(response.response as ArrayBuffer),
  };
}
