const MAX_CONCURRENT_REQUESTS = 4;
const MAX_REQUESTS_PER_WINDOW = 90;
const REQUEST_WINDOW_MS = 5 * 60 * 1000;

type RequestJob = () => Promise<void>;

export interface OpenLibraryResponse {
  status: number;
  bytes: Uint8Array;
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

    void job().finally(() => {
      schedulerState.activeRequests--;
      pump();
    });
  }
}

export function scheduleOpenLibraryRequest(
  url: string,
): Promise<OpenLibraryResponse> {
  return new Promise<OpenLibraryResponse>((resolve, reject) => {
    requestQueue.push(async () => {
      try {
        resolve(await requestOpenLibraryCover(url));
      } catch (error) {
        reject(error);
      }
    });
    pump();
  });
}

async function requestOpenLibraryCover(
  url: string,
): Promise<OpenLibraryResponse> {
  const response = await Zotero.HTTP.request("GET", url, {
    headers: { Accept: "image/jpeg" },
    responseType: "arraybuffer",
    successCodes: [200, 404],
    timeout: 15_000,
    errorDelayMax: 0,
  });
  return {
    status: response.status,
    bytes: new Uint8Array(response.response as ArrayBuffer),
  };
}
