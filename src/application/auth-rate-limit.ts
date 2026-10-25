import { Context, Effect } from "effect";

export type AuthFailureConsumption = "ok" | "limited";

export class AuthRateLimit extends Context.Service<
  AuthRateLimit,
  {
    readonly consumeFailure: (key: string) => Effect.Effect<AuthFailureConsumption>;
  }
>()("satispay/AuthRateLimit") {}
