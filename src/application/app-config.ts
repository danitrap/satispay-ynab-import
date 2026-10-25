import type { CalendarDate, YnabAccountId, YnabPlanId } from "../domain/primitives.ts";
import { Context, Data, Effect, type Redacted } from "effect";

/** Cloudflare bindings are read only at the request adapter. */
export type YnabEnv = {
  YNAB_TOKEN?: string;
  YNAB_PLAN_ID?: string;
  YNAB_ACCOUNT_ID?: string;
  YNAB_IMPORT_FROM?: string;
  YNAB_WRITE_ENABLED?: string;
};
export type AppEnv = YnabEnv & { UPLOAD_TOKEN?: string };

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly key: keyof AppEnv;
  readonly message: string;
}> {}

export type YnabTarget = {
  readonly token: Redacted.Redacted<string>;
  readonly planId: YnabPlanId;
  readonly accountId: YnabAccountId;
};

/** Port for lazily decoded request configuration. */
export type AppConfigShape = {
  readonly uploadToken: Effect.Effect<Redacted.Redacted<string>, ConfigurationError>;
  readonly token: Effect.Effect<Redacted.Redacted<string>, ConfigurationError>;
  readonly target: Effect.Effect<YnabTarget, ConfigurationError>;
  readonly importFrom: Effect.Effect<CalendarDate, ConfigurationError>;
  readonly writesEnabled: Effect.Effect<boolean, ConfigurationError>;
};

/** Values are decoded lazily: inspection and health never require YNAB credentials. */
export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("satispay/AppConfig") {}
