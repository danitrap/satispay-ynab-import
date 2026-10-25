import { AuthRateLimit } from "./application/auth-rate-limit.ts";
import { Effect, Redacted } from "effect";

const encoder = new TextEncoder();
const MAX_CLIENT_KEY_LENGTH = 128;
const CLIENT_ADDRESS = /^[0-9A-Fa-f:.]+$/;

/**
 * Constant-time check of the raw Authorization value against `Bearer <token>`.
 * `timingSafeEqual` throws when the lengths differ. Returning before the compare
 * would reveal the secret length, so a mismatch compares the supplied bytes
 * with themselves and still fails.
 */
function authorizationMatches(provided: string, expected: string): boolean {
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  try {
    if (providedBytes.byteLength !== expectedBytes.byteLength) {
      return !timingSafeEqualBytes(providedBytes, providedBytes);
    }
    return timingSafeEqualBytes(providedBytes, expectedBytes) === true;
  } catch {
    return false;
  }
}

type TimingSafeEqual = (
  left: ArrayBuffer | ArrayBufferView,
  right: ArrayBuffer | ArrayBufferView,
) => boolean;

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  // DOM's SubtleCrypto type omits the Workers method. Call it when the runtime has it.
  const compare = (crypto.subtle as SubtleCrypto & { timingSafeEqual?: TimingSafeEqual })
    .timingSafeEqual;
  if (typeof compare === "function") return compare(left, right);
  return fallbackTimingSafeEqual(left, right);
}

/** Node's Web Crypto has no `timingSafeEqual`. Tests run there; Workers do not. */
function fallbackTimingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    throw new Error("timingSafeEqual length mismatch");
  }
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index++) {
    mismatch |= left[index]! ^ right[index]!;
  }
  return mismatch === 0;
}

function clientKey(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  if (
    address.length === 0 ||
    address.length > MAX_CLIENT_KEY_LENGTH ||
    !CLIENT_ADDRESS.test(address)
  ) {
    return "unknown-client";
  }
  return address;
}

export type AuthorizationDecision =
  | { readonly _tag: "Authorized" }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "RateLimited" };

export const authorizeEffect = Effect.fnUntraced(function* (
  request: Request,
  uploadToken: Redacted.Redacted<string>,
) {
  const provided = request.headers.get("Authorization") ?? "";
  const expected = "Bearer " + Redacted.value(uploadToken);
  if (authorizationMatches(provided, expected)) {
    return { _tag: "Authorized" } satisfies AuthorizationDecision;
  }
  const rateLimit = yield* AuthRateLimit;
  const consumption = yield* rateLimit.consumeFailure(clientKey(request));
  if (consumption === "limited") {
    return { _tag: "RateLimited" } satisfies AuthorizationDecision;
  }
  return { _tag: "Unauthorized" } satisfies AuthorizationDecision;
});
