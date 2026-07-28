const providerIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export type PresentationWidgetProviderFailureScope = "provider" | "shared";

export interface ClassifiedPresentationWidgetProviderFailure<Failure> {
  readonly scope: PresentationWidgetProviderFailureScope;
  readonly value: Failure;
}

export interface PresentationWidgetProvider<Value, Failure> {
  readonly classifyFailure: (
    reason: unknown,
  ) => ClassifiedPresentationWidgetProviderFailure<Failure>;
  readonly eligible: boolean;
  readonly id: string;
  /**
   * Loaders must cooperatively settle after the supplied signal is aborted.
   * The host never releases their concurrency slot before that settlement.
   */
  readonly load: (signal: AbortSignal) => Promise<Value>;
  readonly timeoutFailure: ClassifiedPresentationWidgetProviderFailure<Failure>;
}

export type PresentationWidgetProviderResult<Value, Failure> =
  | { readonly id: string; readonly status: "fulfilled"; readonly value: Value }
  | { readonly failure: Failure; readonly id: string; readonly status: "rejected" }
  | { readonly failure: Failure; readonly id: string; readonly status: "timed_out" }
  | { readonly id: string; readonly status: "ineligible" };

export interface PresentationWidgetProviderHostOptions {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

export class PresentationWidgetProviderHostError extends Error {
  readonly providerId: string | null;

  constructor(providerId: string | null = null) {
    super("The presentation widget provider host is unavailable");
    this.name = "PresentationWidgetProviderHostError";
    this.providerId = providerId;
  }
}

type InternalResult<Value, Failure> =
  | PresentationWidgetProviderResult<Value, Failure>
  | {
      readonly failure: Failure;
      readonly id: string;
      readonly scope: PresentationWidgetProviderFailureScope;
      readonly status: "classified_failure";
    }
  | {
      readonly failure: Failure;
      readonly id: string;
      readonly scope: PresentationWidgetProviderFailureScope;
      readonly status: "timeout_failure";
    }
  | { readonly id: string; readonly status: "host_error" };

function validateHost<Value, Failure>(
  providers: readonly PresentationWidgetProvider<Value, Failure>[],
  options: PresentationWidgetProviderHostOptions,
): void {
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 8 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 30_000 ||
    providers.length > 100
  ) {
    throw new PresentationWidgetProviderHostError();
  }
  const ids = new Set<string>();
  for (const provider of providers) {
    if (
      !providerIdPattern.test(provider.id) ||
      provider.id.length > 160 ||
      ids.has(provider.id) ||
      typeof provider.eligible !== "boolean" ||
      typeof provider.load !== "function" ||
      typeof provider.classifyFailure !== "function" ||
      provider.timeoutFailure === null ||
      typeof provider.timeoutFailure !== "object" ||
      (provider.timeoutFailure.scope !== "provider" &&
        provider.timeoutFailure.scope !== "shared") ||
      !Object.hasOwn(provider.timeoutFailure, "value")
    ) {
      throw new PresentationWidgetProviderHostError();
    }
    ids.add(provider.id);
  }
}

function settleProvider<Value, Failure>(
  provider: PresentationWidgetProvider<Value, Failure>,
  timeoutMs: number,
): Promise<InternalResult<Value, Failure>> {
  if (!provider.eligible) {
    return Promise.resolve({ id: provider.id, status: "ineligible" });
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return Promise.resolve()
    .then(() => provider.load(controller.signal))
    .then(
      (value): InternalResult<Value, Failure> => {
        clearTimeout(timer);
        if (timedOut) {
          return {
            failure: provider.timeoutFailure.value,
            id: provider.id,
            scope: provider.timeoutFailure.scope,
            status: "timeout_failure",
          };
        }
        return { id: provider.id, status: "fulfilled", value };
      },
      (reason: unknown): InternalResult<Value, Failure> => {
        clearTimeout(timer);
        if (timedOut) {
          return {
            failure: provider.timeoutFailure.value,
            id: provider.id,
            scope: provider.timeoutFailure.scope,
            status: "timeout_failure",
          };
        }
        try {
          const failure = provider.classifyFailure(reason);
          if (
            failure === null ||
            typeof failure !== "object" ||
            (failure.scope !== "provider" && failure.scope !== "shared") ||
            !Object.hasOwn(failure, "value")
          ) {
            return { id: provider.id, status: "host_error" };
          }
          return {
            failure: failure.value,
            id: provider.id,
            scope: failure.scope,
            status: "classified_failure",
          };
        } catch {
          return { id: provider.id, status: "host_error" };
        }
      },
    );
}

export async function settlePresentationWidgetProviders<Value, Failure>(
  providers: readonly PresentationWidgetProvider<Value, Failure>[],
  options: PresentationWidgetProviderHostOptions,
): Promise<readonly PresentationWidgetProviderResult<Value, Failure>[]> {
  validateHost(providers, options);
  const results = new Array<InternalResult<Value, Failure>>(providers.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < providers.length) {
      const index = nextIndex;
      nextIndex += 1;
      const provider = providers[index];
      if (!provider) throw new PresentationWidgetProviderHostError();
      results[index] = await settleProvider(provider, options.timeoutMs);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, Math.max(1, providers.length)) }, () =>
      worker(),
    ),
  );

  const hostError = results.find(({ status }) => status === "host_error");
  if (hostError) throw new PresentationWidgetProviderHostError(hostError.id);
  const sharedFailure = results.find(
    (result) =>
      (result.status === "classified_failure" || result.status === "timeout_failure") &&
      result.scope === "shared",
  );
  if (sharedFailure) throw new PresentationWidgetProviderHostError(sharedFailure.id);

  return Object.freeze(
    results.map((result) => {
      if (result.status === "classified_failure") {
        return Object.freeze({
          failure: result.failure,
          id: result.id,
          status: "rejected" as const,
        });
      }
      if (result.status === "timeout_failure") {
        return Object.freeze({
          failure: result.failure,
          id: result.id,
          status: "timed_out" as const,
        });
      }
      if (result.status === "host_error") {
        throw new PresentationWidgetProviderHostError(result.id);
      }
      return Object.freeze(result);
    }),
  );
}
