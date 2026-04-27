const { runDerivedPreflight } = require('./preflight-derived');

function response(body, init = {}) {
  return new Response(body, init);
}

describe('runDerivedPreflight', () => {
  const cssBase = 'http://localhost:3000';
  const asBase = 'http://localhost:4000/uma';
  const pandaBase = 'http://localhost:8080';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes when the fixed derived resources return UMA challenges', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(response('ok', { status: 200 }))
      .mockResolvedValueOnce(response(JSON.stringify({ token_endpoint: `${asBase}/token` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(response('ok', { status: 200 }))
      .mockResolvedValueOnce(response('', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'UMA realm="solid", as_uri="http://localhost:4000/uma", ticket="ticket-1"',
        },
      }))
      .mockResolvedValueOnce(response('', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'UMA realm="solid", as_uri="http://localhost:4000/uma", ticket="ticket-2"',
        },
      }));

    await expect(runDerivedPreflight({
      cssBase,
      asBase,
      pandaBase,
      resourcePaths: ['alice/spo2/'],
    })).resolves.toMatchObject({
      passed: true,
      failed_checks: 0,
      stale_registrations: 0,
    });
  });

  it('rejects a protected resource that returns HTTP 500 with a stale-registration hint', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(response('ok', { status: 200 }))
      .mockResolvedValueOnce(response(JSON.stringify({ token_endpoint: `${asBase}/token` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(response('ok', { status: 200 }))
      .mockResolvedValueOnce(response('Error while requesting UMA header: .', { status: 500 }));

    await expect(runDerivedPreflight({
      cssBase,
      asBase,
      pandaBase,
      resourcePaths: ['alice/spo2/'],
    })).rejects.toThrow(/stale UMA registration/i);
  });
});