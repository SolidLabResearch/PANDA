'use strict';

const http = require('http');
const { Parser } = require('n3');

const CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
const PROTECTED_RESULT_NS = 'http://example.org/panda-benchmark#';

function isoNow() {
  return new Date().toISOString();
}

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) {
    throw new Error('Missing WWW-Authenticate header');
  }
  const headerWithoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(headerWithoutScheme.split(/\s*,\s*/).map((param) => {
    const separatorIndex = param.indexOf('=');
    if (separatorIndex < 0) return [param.trim(), ''];
    return [
      param.slice(0, separatorIndex).trim(),
      param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, ''),
    ];
  }));
  if (!params.as_uri || !params.ticket) {
    throw new Error(`Invalid UMA challenge: ${wwwAuthenticateHeader}`);
  }
  const tokenEndpoint = new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString();
  return { tokenEndpoint, ticket: params.ticket };
}

function normalizeUrlCandidate(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function notificationMatches(payload, expectedResourceUrl) {
  const expected = normalizeUrlCandidate(expectedResourceUrl);
  if (!expected) return false;
  const candidates = [
    payload?.id,
    payload?.object,
    payload?.target,
    payload?.topic,
    payload?.state,
  ]
    .map(normalizeUrlCandidate)
    .filter(Boolean);
  return candidates.includes(expected);
}

async function extractNotificationChannel(resourceUrl) {
  const fallback = `${new URL(resourceUrl).origin}/.notifications/WebhookChannel2023/`;
  try {
    const response = await fetch(resourceUrl, { method: 'HEAD' });
    const linkHeader = response.headers.get('link') || '';
    const storageDescriptionRel = 'http://www.w3.org/ns/solid/terms#storageDescription';
    const storageDescriptionPart = linkHeader
      .split(',')
      .find((part) => part.includes(`rel="${storageDescriptionRel}"`));
    const storageDescriptionMatch = storageDescriptionPart?.match(/<([^>]+)>/);
    if (!storageDescriptionMatch) {
      return {
        channelUrl: fallback,
        discoveryMethod: 'fallback_origin_default',
      };
    }

    const storageDescriptionUrl = new URL(storageDescriptionMatch[1], resourceUrl).toString();
    const storageDescriptionResponse = await fetch(storageDescriptionUrl);
    if (!storageDescriptionResponse.ok) {
      return {
        channelUrl: fallback,
        discoveryMethod: 'fallback_storage_description_fetch_failed',
      };
    }

    const storeTurtle = await storageDescriptionResponse.text();
    const parser = new Parser({ format: 'text/turtle' });
    const quads = parser.parse(storeTurtle);
    const subscriptionPredicate = 'http://www.w3.org/ns/solid/notifications#subscription';
    const channelTypePredicate = 'http://www.w3.org/ns/solid/notifications#channelType';
    const webhookChannelType = 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023';
    const channels = quads
      .filter((quad) => quad.predicate.value === subscriptionPredicate)
      .map((quad) => {
        const location = new URL(quad.object.value, resourceUrl).toString();
        const channelType = quads.find((candidate) => (
          candidate.subject.value === quad.object.value
          && candidate.predicate.value === channelTypePredicate
        ))?.object?.value;
        return { location, channelType };
      });
    const selected = channels.find((channel) => channel.channelType === webhookChannelType) || channels[0];
    return {
      channelUrl: selected?.location || fallback,
      discoveryMethod: selected ? 'storage_description_subscription' : 'fallback_no_channel_in_storage_description',
    };
  } catch (error) {
    return {
      channelUrl: fallback,
      discoveryMethod: `fallback_error:${error?.message || error}`,
    };
  }
}

async function subscribeToWebhookChannel(channelUrl, topic, sendTo, claimToken) {
  const payload = {
    '@context': ['https://www.w3.org/ns/solid/notification/v1'],
    type: 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023',
    topic,
    sendTo,
  };
  let response = await fetch(channelUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(payload),
  });
  if ((response.status === 401 || response.status === 403) && claimToken) {
    const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate') || '');
    const token = await exchangeToken(challenge.tokenEndpoint, challenge.ticket, claimToken);
    response = await fetch(channelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        Authorization: `${token.json?.token_type || 'Bearer'} ${token.json?.access_token || ''}`,
      },
      body: JSON.stringify(payload),
    });
  }
  const body = await response.text().catch(() => '');
  return {
    ok: response.ok,
    status: response.status,
    body,
    location: response.headers.get('Location') || response.headers.get('location') || null,
    payload,
  };
}

async function startWebhookObserver(expectedResourceUrl) {
  const notifications = [];
  let server;
  let resolveWait;
  let rejectWait;
  let waiting = null;

  const waitForNotification = (timeoutMs) => {
    const relevant = notifications.find((entry) => entry.matchesExpected);
    if (relevant) return Promise.resolve(relevant);
    if (waiting) return waiting.promise;
    waiting = {};
    waiting.promise = new Promise((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
      waiting.timeout = setTimeout(() => {
        waiting = null;
        reject(new Error(`Timed out waiting for protected result notification for ${expectedResourceUrl}`));
      }, timeoutMs);
    });
    return waiting.promise;
  };

  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = body.length > 0 ? JSON.parse(body) : null;
        } catch (_) {
          parsed = null;
        }
        const entry = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
          parsed,
          received_at: isoNow(),
          matchesExpected: notificationMatches(parsed || {}, expectedResourceUrl),
        };
        notifications.push(entry);
        if (entry.matchesExpected && resolveWait) {
          clearTimeout(waiting?.timeout);
          const localResolve = resolveWait;
          resolveWait = null;
          rejectWait = null;
          waiting = null;
          localResolve(entry);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const sendTo = `http://127.0.0.1:${address.port}/solid-notifications`;
  return {
    sendTo,
    notifications,
    waitForNotification,
    async close() {
      if (waiting?.timeout) clearTimeout(waiting.timeout);
      if (rejectWait) {
        rejectWait(new Error('Notification observer closed before notification arrived'));
      }
      resolveWait = null;
      rejectWait = null;
      waiting = null;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function fetchUmaChallenge(resourceUrl) {
  const startedAt = Date.now();
  const response = await fetch(resourceUrl, { method: 'GET' });
  const endedAt = Date.now();
  const body = await response.text().catch(() => '');
  return {
    status: response.status,
    body,
    header: response.headers.get('WWW-Authenticate') || '',
    durationMs: endedAt - startedAt,
  };
}

async function exchangeToken(tokenEndpoint, ticket, claimToken) {
  const startedAt = Date.now();
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(claimToken),
      claim_token_format: CLAIM_TOKEN_FORMAT,
    }),
  });
  const endedAt = Date.now();
  const rawBody = await response.text().catch(() => '');
  let json = null;
  try {
    json = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch (_) {
    json = null;
  }
  return {
    status: response.status,
    durationMs: endedAt - startedAt,
    rawBody,
    json,
  };
}

async function authorizedGet(resourceUrl, tokenType, accessToken) {
  const startedAt = Date.now();
  const response = await fetch(resourceUrl, {
    method: 'GET',
    headers: {
      Authorization: `${tokenType || 'Bearer'} ${accessToken}`,
    },
  });
  const endedAt = Date.now();
  const body = await response.text().catch(() => '');
  return {
    status: response.status,
    durationMs: endedAt - startedAt,
    body,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function extractLiteralOrUri(quads, predicateSuffix) {
  const quad = quads.find((candidate) => candidate.predicate.value === `${PROTECTED_RESULT_NS}${predicateSuffix}`);
  if (!quad) return null;
  return quad.object.value;
}

function parseProtectedResultTurtle(body) {
  const parser = new Parser({ format: 'text/turtle' });
  const quads = parser.parse(body);
  return {
    benchmarkRunId: extractLiteralOrUri(quads, 'benchmarkRunId'),
    scenarioId: extractLiteralOrUri(quads, 'scenarioId'),
    sourceEventId: extractLiteralOrUri(quads, 'sourceEventId'),
    rspQueryHash: extractLiteralOrUri(quads, 'rspQueryHash'),
    rspWindowStart: extractLiteralOrUri(quads, 'rspWindowStart'),
    rspWindowEnd: extractLiteralOrUri(quads, 'rspWindowEnd'),
    rspResultTimestamp: extractLiteralOrUri(quads, 'rspResultTimestamp'),
    derivedFrom: extractLiteralOrUri(quads, 'derivedFrom'),
    createdAt: extractLiteralOrUri(quads, 'createdAt'),
    actualValue: extractLiteralOrUri(quads, 'actualValue'),
  };
}

function checkOdrlLogProof(logChunk, resourceUrl, claimToken) {
  if (!logChunk || !/OdrlAuthorizer/.test(logChunk)) {
    return {
      passed: false,
      reason: 'OdrlAuthorizer marker not found in log delta',
    };
  }
  const escapedClaim = String(claimToken).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedResource = String(resourceUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allowPattern = new RegExp(`Evaluating Request \\[S R AR\\]: \\[${escapedClaim} ${escapedResource} `);
  return {
    passed: allowPattern.test(logChunk),
    reason: allowPattern.test(logChunk)
      ? null
      : `Allow evaluation log missing for claim=${claimToken} resource=${resourceUrl}`,
  };
}

module.exports = {
  PROTECTED_RESULT_NS,
  parseAuthenticateHeader,
  extractNotificationChannel,
  subscribeToWebhookChannel,
  startWebhookObserver,
  fetchUmaChallenge,
  exchangeToken,
  authorizedGet,
  parseProtectedResultTurtle,
  checkOdrlLogProof,
};
