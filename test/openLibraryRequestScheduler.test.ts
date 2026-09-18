import { assert } from "chai";
import {
  OpenLibraryRequestScheduler,
  OpenLibraryResponse,
} from "../src/modules/openLibraryRequestScheduler";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("Open Library request scheduler", function () {
  it("limits concurrent requests", async function () {
    const completions: Array<(response: OpenLibraryResponse) => void> = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new OpenLibraryRequestScheduler({
      maxConcurrentRequests: 2,
      request: () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        return new Promise((resolve) => {
          completions.push((response) => {
            active--;
            resolve(response);
          });
        });
      },
    });

    const requests = ["one", "two", "three"].map((url) =>
      scheduler.schedule(url),
    );
    assert.equal(completions.length, 2);

    completions.shift()!({ status: 200, bytes: jpeg });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(completions.length, 2);

    for (const complete of completions) {
      complete({ status: 200, bytes: jpeg });
    }
    await Promise.all(requests);
    assert.equal(maximumActive, 2);
  });

  it("waits for rolling-window capacity", async function () {
    const starts: number[] = [];
    const scheduler = new OpenLibraryRequestScheduler({
      maxConcurrentRequests: 3,
      maxRequestsPerWindow: 2,
      requestWindowMs: 50,
      request: async () => {
        starts.push(Date.now());
        return { status: 200, bytes: jpeg };
      },
    });

    const responses = await Promise.all([
      scheduler.schedule("one"),
      scheduler.schedule("two"),
      scheduler.schedule("three"),
    ]);

    assert.lengthOf(responses, 3);
    assert.lengthOf(starts, 3);
    assert.isAtLeast(starts[2] - starts[0], 40);
  });

  for (const status of [403, 429]) {
    it(`backs off and retries status ${status}`, async function () {
      let attempts = 0;
      const scheduler = new OpenLibraryRequestScheduler({
        requestWindowMs: 10,
        request: async () => {
          attempts++;
          return attempts === 1
            ? { status, bytes: new Uint8Array() }
            : { status: 200, bytes: jpeg };
        },
      });

      const response = await scheduler.schedule("cover");
      assert.equal(response.status, 200);
      assert.equal(attempts, 2);
    });
  }

  it("rejects when the rate limit persists after one retry", async function () {
    let attempts = 0;
    const scheduler = new OpenLibraryRequestScheduler({
      requestWindowMs: 10,
      request: async () => {
        attempts++;
        return { status: 429, bytes: new Uint8Array() };
      },
    });

    let error: unknown;
    try {
      await scheduler.schedule("cover");
    } catch (caught) {
      error = caught;
    }

    assert.match(String(error), /rate limit persisted after retry \(429\)/);
    assert.equal(attempts, 2);
  });

  it("returns ordinary responses without retrying", async function () {
    let attempts = 0;
    const scheduler = new OpenLibraryRequestScheduler({
      request: async () => {
        attempts++;
        return { status: 404, bytes: new Uint8Array() };
      },
    });

    assert.equal((await scheduler.schedule("missing")).status, 404);
    assert.equal(attempts, 1);
  });

  it("rejects request failures", async function () {
    const scheduler = new OpenLibraryRequestScheduler({
      request: async () => {
        throw new Error("network failed");
      },
    });

    let error: unknown;
    try {
      await scheduler.schedule("cover");
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /network failed/);
  });
});
