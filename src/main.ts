import { operationLogger } from "./application/telemetry.ts";
import { handleRequestEffect } from "./http/handle-request.ts";
import { appConfigLayer } from "./infrastructure/app-config.ts";
import { authRateLimitLayer, type WorkerEnv } from "./infrastructure/auth-rate-limit.ts";
import { satispayExportReaderLayer } from "./infrastructure/satispay-export-reader.ts";
import { sheetAnalysisLayer } from "./infrastructure/sheet-analysis.ts";
import { workbookReaderLayer } from "./infrastructure/workbook-reader.ts";
import { ynabGatewayLayer } from "./infrastructure/ynab-gateway.ts";
import { Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/http";

/** Single request composition root. Never retain Cloudflare bindings in a global runtime. */
export const requestLiveLayer = (env: WorkerEnv, fetchFn: typeof fetch = fetch) => {
  const config = appConfigLayer(env);
  const transport = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
  );
  return Layer.mergeAll(
    ynabGatewayLayer.pipe(Layer.provideMerge(config), Layer.provide(transport)),
    workbookReaderLayer,
    satispayExportReaderLayer.pipe(Layer.provide(workbookReaderLayer)),
    sheetAnalysisLayer,
    authRateLimitLayer(env.AUTH_FAILURE_LIMITER),
    Logger.layer([operationLogger]),
  );
};

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return Effect.runPromise(
      handleRequestEffect(request).pipe(Effect.provide(requestLiveLayer(env))),
      { signal: request.signal },
    );
  },
};
