import type { AppEnv } from "../application/app-config.ts";
import { AuthRateLimit, type AuthFailureConsumption } from "../application/auth-rate-limit.ts";
import { Effect, Layer } from "effect";

/** Request bindings. The rate limiter is optional so local tests can omit it. */
export type WorkerEnv = AppEnv & {
  readonly AUTH_FAILURE_LIMITER?: RateLimit;
};

/**
 * Counts one failed attempt. A missing binding, or a binding that throws,
 * does not throttle: the caller still returns 401. The key is a client address,
 * never the upload token.
 */
export const authRateLimitLayer = (limiter: RateLimit | undefined) =>
  Layer.succeed(AuthRateLimit, {
    consumeFailure: (key) => {
      if (!limiter) return Effect.succeed("ok" as const);
      return Effect.tryPromise({
        try: () => limiter.limit({ key }),
        catch: () => "unavailable" as const,
      }).pipe(
        Effect.map((outcome): AuthFailureConsumption => (outcome.success ? "ok" : "limited")),
        Effect.orElseSucceed((): AuthFailureConsumption => "ok"),
      );
    },
  });
