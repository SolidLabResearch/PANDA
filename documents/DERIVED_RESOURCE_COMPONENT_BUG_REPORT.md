# Bug Report: Derived Resource Component Returns 404 Instead of Serving `derived/latest`

## Summary

PANDA can now successfully reach the UMA-authenticated request path for `http://localhost:3000/alice/derived/latest`, but the request still ends in `404 Not Found` after token exchange.

This is not an auth failure.

- `401 Unauthorized` on a tokenless curl is expected and proves UMA challenge issuance works.
- `404 Not Found` on the authenticated fetch means the derived resource itself is not materialized or not resolved by the derived-resource component.

## Expected Behavior

When PANDA or a manual client performs an authenticated `GET` on:

`http://localhost:3000/alice/derived/latest`

the derived-resource component should return the latest replayed event payload, not `404`.

Expected sequence:

1. Anonymous GET returns `401` with UMA challenge.
2. Ticket exchange returns a Bearer token.
3. Authenticated GET returns `200 OK` with the latest event body.

## Actual Behavior

Observed runtime behavior:

1. Anonymous GET:
   - `curl http://localhost:3000/alice/derived/latest`
   - Response: `401 Unauthorized`
2. PANDA authenticated fetch:
   - `GET /alice/derived/latest` is attempted with a valid Bearer token
   - Response: `404 Not Found`

Representative log evidence:

```text
[Fetcher] Attempting to fetch: http://localhost:3000/alice/derived/latest
[Fetcher] Received RPT - Token Type: Bearer
[Fetcher] Final request with RPT.
[Fetcher] Response from stored token fetch: 404
[Fetcher] Stored token failed, status: 404
Failed to fetch notified resource http://localhost:3000/alice/derived/latest. Status: 404
```

## Why This Is a Derived-Resource Problem

The UMA layer is functioning:

- A ticket is issued on unauthenticated access.
- The ticket can be exchanged for an access token.
- The authenticated request reaches the server.

The failure occurs after that, when the server looks for the derived resource.

This means the bug is in one of these places:

1. The derived resource is not being created/materialized.
2. The derived resource is created under a different URI than `/alice/derived/latest`.
3. The derived-resource component is not resolving `latest` and is falling through to generic storage lookup.
4. The replay pipeline is emitting the latest event, but nothing persists it at the expected location.

## Relevant Code Paths

### 1. Notification topic resolution

File: [`src/server/NotificationTopicResolver.ts`](/Users/kushbisen/Code/PANDA%20Platform/PANDA/src/server/NotificationTopicResolver.ts)

Current logic maps notification topics to:

`http://localhost:3000/<pod>/derived/latest`

This is correct for strict latest-only consumption.

### 2. Webhook handling

File: [`src/server/HTTPServer.ts`](/Users/kushbisen/Code/PANDA%20Platform/PANDA/src/server/HTTPServer.ts)

The webhook handler now fetches only the resolved `derived/latest` target.

That means the remaining 404 is not caused by fallback to a source member URL anymore.

### 3. Derived-resource authorization

File: [`src/server/WebSocketHandler.ts`](/Users/kushbisen/Code/PANDA%20Platform/PANDA/src/server/WebSocketHandler.ts)

`authorizeDerivedResource()` constructs derived paths by appending `derived/latest` to the pod owner path.

This confirms the intended URI is `.../derived/latest`, not `/spo2/<id>`.

## Reproduction

Run:

```bash
curl http://localhost:3000/alice/derived/latest
```

Expected:

- `401 Unauthorized`

Then exchange the UMA ticket and retry with `Authorization: Bearer <token>`.

Observed:

- `404 Not Found`

## Impact

Replay does not produce a readable latest resource, so the derived-resource component cannot be used as the single source of truth for notification handling.

This also causes PANDA to keep treating the derived resource as missing even when auth is valid.

## Likely Fix Area

The fix should be in the derived-resource component, not in UMA or webhook auth:

- ensure `derived/latest` is materialized before replay access,
- or make the component serve a virtual/latest view instead of relying on storage lookup,
- or align the replay writer and resolver on the exact same URI.

## Notes

The important distinction is:

- `401` proves the resource path exists from an authorization standpoint.
- `404` proves the content is missing or unresolved at the resource layer.

That is why the failure is in the derived-resource component.
