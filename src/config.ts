import { Config, ConfigProvider, Context, Data, Effect, Layer, Schema } from "effect";

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

const NonEmptyString = Schema.Trimmed.check(Schema.isMinLength(1));
const Secret = Schema.Redacted(NonEmptyString);
const ImportDate = NonEmptyString.check(
  Schema.makeFilter((value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00.000Z");
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }),
);

function makeConfig(env: AppEnv) {
  const provider = ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true });
  const read = <A>(config: Config.Config<A>, key: keyof AppEnv, message: string) =>
    config.parse(provider).pipe(
      // Never retain parser diagnostics: they can contain a rejected secret value.
      Effect.mapError(() => new ConfigurationError({ key, message })),
    );
  const token = read(
    Config.schema(Secret, "YNAB_TOKEN"),
    "YNAB_TOKEN",
    "Missing YNAB_TOKEN secret",
  );
  const target = Effect.all({
    token,
    planId: read(
      Config.schema(NonEmptyString, "YNAB_PLAN_ID"),
      "YNAB_PLAN_ID",
      "Set YNAB_PLAN_ID and YNAB_ACCOUNT_ID",
    ),
    accountId: read(
      Config.schema(NonEmptyString, "YNAB_ACCOUNT_ID"),
      "YNAB_ACCOUNT_ID",
      "Set YNAB_PLAN_ID and YNAB_ACCOUNT_ID",
    ),
  });
  return {
    uploadToken: read(
      Config.schema(Secret, "UPLOAD_TOKEN"),
      "UPLOAD_TOKEN",
      "Missing UPLOAD_TOKEN secret",
    ),
    token,
    target,
    importFrom: read(
      Config.schema(ImportDate, "YNAB_IMPORT_FROM"),
      "YNAB_IMPORT_FROM",
      "Configure YNAB_IMPORT_FROM (YYYY-MM-DD) to exclude previously reconciled history",
    ),
    writesEnabled: read(
      Config.schema(Schema.Literals(["true", "false"]), "YNAB_WRITE_ENABLED").pipe(
        Config.withDefault("false"),
      ),
      "YNAB_WRITE_ENABLED",
      "Invalid YNAB_WRITE_ENABLED: expected true or false",
    ).pipe(Effect.map((value) => value === "true")),
  };
}

/** Values are decoded lazily: inspection and health never require YNAB credentials. */
export class AppConfig extends Context.Service<AppConfig, ReturnType<typeof makeConfig>>()(
  "satispay/AppConfig",
) {}

export const appConfigLayer = (env: AppEnv) => Layer.succeed(AppConfig, makeConfig(env));
