import { describe, expect, it, vi } from "vitest";
import {
  PresentationWidgetProviderHostError,
  settlePresentationWidgetProviders,
} from "./presentation-widget-provider-core";

function provider<Value>(
  id: string,
  load: (signal: AbortSignal) => Promise<Value>,
  options: {
    readonly eligible?: boolean;
    readonly scope?: "provider" | "shared";
    readonly timeoutScope?: "provider" | "shared";
  } = {},
) {
  return {
    classifyFailure: () => ({
      scope: options.scope ?? "provider",
      value: { kind: "safe_failure" },
    }),
    eligible: options.eligible ?? true,
    id,
    load,
    timeoutFailure: {
      scope: options.timeoutScope ?? "provider",
      value: { kind: "safe_timeout" },
    },
  } as const;
}

describe("independent presentation widget provider host", () => {
  it("settles every eligible provider independently in registration order", async () => {
    const started: string[] = [];
    const result = await settlePresentationWidgetProviders(
      [
        provider("provider.first", async () => {
          started.push("first");
          throw new Error("private diagnostic");
        }),
        provider("provider.second", async () => {
          started.push("second");
          return "current";
        }),
      ],
      { concurrency: 2, timeoutMs: 1_000 },
    );

    expect(started).toEqual(["first", "second"]);
    expect(result).toEqual([
      {
        failure: { kind: "safe_failure" },
        id: "provider.first",
        status: "rejected",
      },
      { id: "provider.second", status: "fulfilled", value: "current" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });

  it("caps concurrency and never starts an ineligible provider", async () => {
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ineligibleStarted = false;
    const loaders = ["one", "two", "three", "four"].map((id) =>
      provider(`provider.${id}`, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
        return id;
      }),
    );
    const resultPromise = settlePresentationWidgetProviders(
      [
        ...loaders,
        provider(
          "provider.hidden",
          async () => {
            ineligibleStarted = true;
            return "hidden";
          },
          { eligible: false },
        ),
      ],
      { concurrency: 2, timeoutMs: 1_000 },
    );
    await vi.waitFor(() => expect(maximumActive).toBe(2));
    release?.();
    const result = await resultPromise;

    expect(maximumActive).toBe(2);
    expect(ineligibleStarted).toBe(false);
    expect(result.at(-1)).toEqual({ id: "provider.hidden", status: "ineligible" });
  });

  it("times out and aborts only the affected provider while another provider completes", async () => {
    vi.useFakeTimers();
    try {
      let timedOutSignal: AbortSignal | undefined;
      const resultPromise = settlePresentationWidgetProviders(
        [
          provider(
            "provider.slow",
            (signal) =>
              new Promise((_resolve, reject) => {
                timedOutSignal = signal;
                signal.addEventListener("abort", () => reject(new Error("private abort")), {
                  once: true,
                });
              }),
          ),
          provider("provider.fast", async () => "current"),
        ],
        { concurrency: 2, timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(timedOutSignal?.aborted).toBe(true);
      expect(result).toEqual([
        {
          failure: { kind: "safe_timeout" },
          id: "provider.slow",
          status: "timed_out",
        },
        { id: "provider.fast", status: "fulfilled", value: "current" },
      ]);
      expect(JSON.stringify(result)).not.toContain("private abort");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release a concurrency slot until an aborted loader has cooperatively settled", async () => {
    vi.useFakeTimers();
    try {
      let firstAborted = false;
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let secondStarted = false;
      const resultPromise = settlePresentationWidgetProviders(
        [
          provider("provider.first", async (signal) => {
            signal.addEventListener(
              "abort",
              () => {
                firstAborted = true;
              },
              { once: true },
            );
            await firstGate;
            throw new Error("private delayed abort");
          }),
          provider("provider.second", async () => {
            secondStarted = true;
            return "current";
          }),
        ],
        { concurrency: 1, timeoutMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(firstAborted).toBe(true);
      expect(secondStarted).toBe(false);

      releaseFirst?.();
      await vi.runAllTimersAsync();
      await expect(resultPromise).resolves.toEqual([
        {
          failure: { kind: "safe_timeout" },
          id: "provider.first",
          status: "timed_out",
        },
        { id: "provider.second", status: "fulfilled", value: "current" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles every provider before choosing the first registered shared timeout", async () => {
    vi.useFakeTimers();
    try {
      const settled: string[] = [];
      const resultPromise = settlePresentationWidgetProviders(
        [
          provider(
            "provider.first",
            (signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    settled.push("first");
                    reject(new Error("first private timeout"));
                  },
                  { once: true },
                );
              }),
            { timeoutScope: "shared" },
          ),
          provider(
            "provider.second",
            (signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    settled.push("second");
                    reject(new Error("second private timeout"));
                  },
                  { once: true },
                );
              }),
          ),
        ],
        { concurrency: 2, timeoutMs: 100 },
      );
      const rejection = expect(resultPromise).rejects.toMatchObject({
        name: "PresentationWidgetProviderHostError",
        providerId: "provider.first",
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(settled.sort()).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles all providers before choosing the first registered shared failure", async () => {
    const settled: string[] = [];
    await expect(
      settlePresentationWidgetProviders(
        [
          provider(
            "provider.first",
            async () => {
              await Promise.resolve();
              settled.push("first");
              throw new Error("first private failure");
            },
            { scope: "shared" },
          ),
          provider(
            "provider.second",
            async () => {
              settled.push("second");
              throw new Error("second private failure");
            },
            { scope: "shared" },
          ),
        ],
        { concurrency: 2, timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({
      name: "PresentationWidgetProviderHostError",
      providerId: "provider.first",
    });
    expect(settled.sort()).toEqual(["first", "second"]);
  });

  it("fails closed on duplicate provider identity or invalid host bounds", async () => {
    const duplicate = provider("provider.same", async () => "current");
    await expect(
      settlePresentationWidgetProviders([duplicate, duplicate], {
        concurrency: 1,
        timeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(PresentationWidgetProviderHostError);
    await expect(
      settlePresentationWidgetProviders([duplicate], {
        concurrency: 0,
        timeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(PresentationWidgetProviderHostError);
    await expect(
      settlePresentationWidgetProviders(
        [
          {
            ...duplicate,
            timeoutFailure: {
              scope: "invalid",
              value: { kind: "safe_timeout" },
            },
          } as unknown as typeof duplicate,
        ],
        {
          concurrency: 1,
          timeoutMs: 100,
        },
      ),
    ).rejects.toBeInstanceOf(PresentationWidgetProviderHostError);
  });
});
