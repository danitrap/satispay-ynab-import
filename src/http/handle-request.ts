import { AppConfig } from "../application/app-config.ts";
import { authorizeEffect, type AuthorizationDecision } from "./auth.ts";
import {
  accountsController,
  importController,
  inspectController,
  prepareController,
  previewController,
} from "./controllers.ts";
import { presentAuthorization, presentHealth, presentNotFound } from "./presenters.ts";
import { Effect } from "effect";

type Route = "health" | "accounts" | "inspect" | "preview" | "prepare" | "import";

const matchRoute = (request: Request): Route | undefined => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return "health";
  if (request.method === "GET" && url.pathname === "/ynab/accounts") return "accounts";
  if (request.method !== "POST") return undefined;
  switch (url.pathname) {
    case "/inspect":
      return "inspect";
    case "/preview":
      return "preview";
    case "/prepare":
      return "prepare";
    case "/import":
      return "import";
    default:
      return undefined;
  }
};

/** A missing upload token is the same refusal as a wrong one. The presenter owns the status. */
const authorizeRequest = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return yield* config.uploadToken.pipe(
      Effect.flatMap((token) => authorizeEffect(request, token)),
      Effect.catchTag("ConfigurationError", () =>
        Effect.succeed({ _tag: "Unauthorized" } as const satisfies AuthorizationDecision),
      ),
    );
  });

/** Match a route and authorize it. Controllers call presenters for the response. */
export const handleRequestEffect = Effect.fnUntraced(function* (request: Request) {
  const route = matchRoute(request);
  if (route === undefined) return presentNotFound();
  if (route === "health") return presentHealth();
  const decision = yield* authorizeRequest(request);
  if (decision._tag !== "Authorized") return presentAuthorization(decision);
  switch (route) {
    case "accounts":
      return yield* accountsController();
    case "inspect":
      return yield* inspectController(request);
    case "preview":
      return yield* previewController(request);
    case "prepare":
      return yield* prepareController(request);
    case "import":
      return yield* importController(request);
  }
});
