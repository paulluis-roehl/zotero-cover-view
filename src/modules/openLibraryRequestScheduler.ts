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

export interface OpenLibraryRequestSchedulerOptions {
  maxConcurrentRequests?: number;
  maxRequestsPerWindow?: number;
  requestWindowMs?: number;
  maxRateLimitRetries?: number;
  request?: (url: string) => Promise<OpenLibraryResponse>;
}

export class OpenLibraryRequestScheduler {
  private activeRequests = 0;
  private blockedUntil = 0;
  private readonly requestStarts: number[] = [];
  private readonly requestQueue: RequestJob[] = [];
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly maxConcurrentRequests: number;
  private readonly maxRequestsPerWindow: number;
  private readonly requestWindowMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly request: (url: string) => Promise<OpenLibraryResponse>;

  constructor(options: OpenLibraryRequestSchedulerOptions = {}) {
    this.maxConcurrentRequests =
      options.maxConcurrentRequests ?? MAX_CONCURRENT_REQUESTS;
    this.maxRequestsPerWindow =
      options.maxRequestsPerWindow ?? MAX_REQUESTS_PER_WINDOW;
    this.requestWindowMs = options.requestWindowMs ?? REQUEST_WINDOW_MS;
    this.maxRateLimitRetries =
      options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
    this.request = options.request ?? requestOpenLibraryCover;
  }

  schedule(url: string): Promise<OpenLibraryResponse> {
    return new Promise<OpenLibraryResponse>((resolve, reject) => {
      this.requestQueue.push({ url, resolve, reject, rateLimitRetries: 0 });
      this.pump();
    });
  }

  private scheduleWakeUp(delay: number): void {
    if (this.wakeTimer !== undefined) return;

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, delay);
  }

  private pump(): void {
    const now = Date.now();
    while (
      this.requestStarts.length > 0 &&
      this.requestStarts[0] <= now - this.requestWindowMs
    ) {
      this.requestStarts.shift();
    }

    if (this.requestQueue.length === 0) return;

    const quotaAvailableAt =
      this.requestStarts.length >= this.maxRequestsPerWindow
        ? this.requestStarts[0] + this.requestWindowMs
        : now;
    const nextStartAt = Math.max(this.blockedUntil, quotaAvailableAt);
    if (nextStartAt > now) {
      this.scheduleWakeUp(nextStartAt - now);
      return;
    }

    while (
      this.requestQueue.length > 0 &&
      this.activeRequests < this.maxConcurrentRequests &&
      this.requestStarts.length < this.maxRequestsPerWindow
    ) {
      const job = this.requestQueue.shift()!;
      this.activeRequests++;
      this.requestStarts.push(Date.now());

      void this.runJob(job).finally(() => {
        this.activeRequests--;
        this.pump();
      });
    }
  }

  private async runJob(job: RequestJob): Promise<void> {
    try {
      const response = await this.request(job.url);
      if (response.status === 403 || response.status === 429) {
        if (job.rateLimitRetries >= this.maxRateLimitRetries) {
          job.reject(
            new Error(
              `Open Library rate limit persisted after retry (${response.status})`,
            ),
          );
          return;
        }

        job.rateLimitRetries++;
        this.blockedUntil = Math.max(
          this.blockedUntil,
          Date.now() + this.requestWindowMs,
        );
        this.requestQueue.push(job);
        return;
      }
      job.resolve(response);
    } catch (error) {
      job.reject(error);
    }
  }
}

const scheduler = new OpenLibraryRequestScheduler();

export function scheduleOpenLibraryRequest(
  url: string,
): Promise<OpenLibraryResponse> {
  return scheduler.schedule(url);
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
