import { assert } from "chai";
import {
  OpenLibraryRequestScheduler,
  OpenLibraryResponse,
} from "../src/modules/openLibraryRequestScheduler";
import { until } from "./helpers/gridFixture";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function reply(status: number): OpenLibraryResponse {
  return { status, bytes: status === 200 ? jpeg : new Uint8Array() };
}

/**
 * A request function answering each URL with the next of its `statuses`, repeating the
 * last one.
 */
function respondWith(statuses: Record<string, number[]> = {}) {
  return async (url: string) => {
    const remaining = statuses[url] ?? [200];
    return reply(remaining.length > 1 ? remaining.shift()! : remaining[0]);
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to be rejected");
}

describe("Open Library request scheduler", function () {
  it("runs no more than the allowed number of requests at once", async function () {
    const inFlight = new Map<string, () => void>();
    let mostInFlight = 0;
    const scheduler = new OpenLibraryRequestScheduler({
      maxConcurrentRequests: 2,
      request: (url) =>
        new Promise((resolve) => {
          inFlight.set(url, () => {
            inFlight.delete(url);
            resolve(reply(200));
          });
          mostInFlight = Math.max(mostInFlight, inFlight.size);
        }),
    });
    const responses = ["one", "two", "three"].map((url) =>
      scheduler.schedule(url),
    );
    await until(() => inFlight.size === 2, "two requests to start");
    assert.sameMembers([...inFlight.keys()], ["one", "two"]);
    inFlight.get("one")!();
    await until(() => inFlight.has("three"), "the third request to start");
    for (const finish of inFlight.values()) finish();
    for (const response of responses)
      assert.equal((await response).status, 200);
    assert.equal(mostInFlight, 2);
  });

  it("waits for room in the rolling request window", async function () {
    const started = new Set<string>();
    const scheduler = new OpenLibraryRequestScheduler({
      maxRequestsPerWindow: 2,
      requestWindowMs: 2000,
      request: async (url) => {
        started.add(url);
        return reply(200);
      },
    });
    const [one, two, three] = ["one", "two", "three"].map((url) =>
      scheduler.schedule(url),
    );
    await Promise.all([one, two]);
    assert.isFalse(started.has("three"), "the window is full");
    assert.equal((await three).status, 200, "the window has room again");
  });

  for (const status of [403, 429])
    it(`retries a request rate limited with status ${status}`, async function () {
      const scheduler = new OpenLibraryRequestScheduler({
        requestWindowMs: 10,
        request: respondWith({ cover: [status, 200] }),
      });
      assert.equal((await scheduler.schedule("cover")).status, 200);
    });

  it("fails a request that stays rate limited", async function () {
    const scheduler = new OpenLibraryRequestScheduler({
      requestWindowMs: 10,
      request: respondWith({ cover: [429] }),
    });
    assert.match(
      String(await rejection(scheduler.schedule("cover"))),
      /rate limit/,
    );
  });

  it("returns other responses without retrying", async function () {
    const scheduler = new OpenLibraryRequestScheduler({
      requestWindowMs: 10,
      request: respondWith({ missing: [404, 200] }),
    });
    assert.equal((await scheduler.schedule("missing")).status, 404);
  });

  it("fails a request that fails", async function () {
    const scheduler = new OpenLibraryRequestScheduler({
      request: async () => {
        throw new Error("network failed");
      },
    });
    assert.match(
      String(await rejection(scheduler.schedule("cover"))),
      /network failed/,
    );
  });
});
