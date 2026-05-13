jest.mock('cross-fetch', () => ({
  fetch: jest.fn(),
}));

const crossFetch = require('cross-fetch');
const { ReuseTokenUMAFetcher } = require('./ReuseTokenUMAFetcher');
const { TokenManagerService } = require('../service/TokenManagerService');

function mockResponse(status, headers = {}, jsonBody = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    json: async () => jsonBody,
    text: async () => '',
  };
}

describe('ReuseTokenUMAFetcher benchmark guard', () => {
  const mockedFetch = crossFetch.fetch;

  beforeEach(() => {
    mockedFetch.mockReset();
    delete process.env.REPLAYER_UMA_BENCHMARK_MODE;
    TokenManagerService.getInstance().clearAccessToken();
  });

  test('rejects public endpoints in benchmark mode', async () => {
    process.env.REPLAYER_UMA_BENCHMARK_MODE = 'true';
    mockedFetch.mockResolvedValue(mockResponse(200));
    const subject = new ReuseTokenUMAFetcher({
      token: 'http://localhost:3000/alice/profile/card#me',
      token_format: 'urn:solidlab:uma:claims:formats:webid',
    });

    await expect(subject.fetch('http://localhost:3000/alice/acc-x/')).rejects.toThrow(
      /Benchmark guard: .*without UMA challenge/
    );
  });

  test('keeps non-benchmark behavior unchanged for public endpoints', async () => {
    mockedFetch.mockResolvedValue(mockResponse(200));
    const subject = new ReuseTokenUMAFetcher({
      token: 'http://localhost:3000/alice/profile/card#me',
      token_format: 'urn:solidlab:uma:claims:formats:webid',
    });

    const response = await subject.fetch('http://localhost:3000/alice/acc-x/');
    expect(response.status).toBe(200);
  });

  test('shares token cache across fetcher instances for the same container URL', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockResponse(401, {
        'WWW-Authenticate': 'UMA as_uri="https://auth.example", ticket="ticket-a"',
      }))
      .mockResolvedValueOnce(mockResponse(200, {}, { access_token: 'rpt-a', token_type: 'Bearer' }))
      .mockResolvedValueOnce(mockResponse(201))
      .mockResolvedValueOnce(mockResponse(200));

    const firstFetcher = new ReuseTokenUMAFetcher({
      token: 'http://localhost:3000/alice/profile/card#me',
      token_format: 'urn:solidlab:uma:claims:formats:webid',
    });
    const secondFetcher = new ReuseTokenUMAFetcher({
      token: 'http://localhost:3000/alice/profile/card#me',
      token_format: 'urn:solidlab:uma:claims:formats:webid',
    });

    await firstFetcher.fetch('http://localhost:3000/alice/acc-shared/');
    await secondFetcher.fetch('http://localhost:3000/alice/acc-shared/');

    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(mockedFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/alice/acc-shared/', {});
    expect(mockedFetch).toHaveBeenNthCalledWith(2, 'https://auth.example/token', expect.any(Object));
    expect(mockedFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/alice/acc-shared/', expect.any(Object));
    expect(mockedFetch).toHaveBeenNthCalledWith(4, 'http://localhost:3000/alice/acc-shared/', expect.any(Object));

    const sharedCallHeaders = mockedFetch.mock.calls[3][1].headers;
    expect(sharedCallHeaders.get('Authorization')).toBe('Bearer rpt-a');
  });

  test('does not share token cache across different container URLs', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockResponse(401, {
        'WWW-Authenticate': 'UMA as_uri="https://auth.example", ticket="ticket-a"',
      }))
      .mockResolvedValueOnce(mockResponse(200, {}, { access_token: 'rpt-a', token_type: 'Bearer' }))
      .mockResolvedValueOnce(mockResponse(201))
      .mockResolvedValueOnce(mockResponse(401, {
        'WWW-Authenticate': 'UMA as_uri="https://auth.example", ticket="ticket-b"',
      }))
      .mockResolvedValueOnce(mockResponse(200, {}, { access_token: 'rpt-b', token_type: 'Bearer' }))
      .mockResolvedValueOnce(mockResponse(201));

    const firstFetcher = new ReuseTokenUMAFetcher({
      token: 'http://localhost:3000/alice/profile/card#me',
      token_format: 'urn:solidlab:uma:claims:formats:webid',
    });
    const secondFetcher = new ReuseTokenUMAFetcher({
      token: 'http://localhost:3000/alice/profile/card#me',
      token_format: 'urn:solidlab:uma:claims:formats:webid',
    });

    await firstFetcher.fetch('http://localhost:3000/alice/acc-a/');
    await secondFetcher.fetch('http://localhost:3000/alice/acc-b/');

    expect(mockedFetch).toHaveBeenCalledTimes(6);
    expect(mockedFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/alice/acc-a/', {});
    expect(mockedFetch).toHaveBeenNthCalledWith(4, 'http://localhost:3000/alice/acc-b/', {});
  });
});
