import { EventEmitter } from 'events';
import { NotificationStreamProcessor } from './NotificationStreamProcessor';
import { create_subscription, extract_subscription_server } from '../../utils/notifications/Util';

jest.mock('../../utils/notifications/Util', () => ({
  create_subscription: jest.fn(),
  extract_subscription_server: jest.fn(),
  extract_ldp_inbox: jest.fn(),
}));

describe('NotificationStreamProcessor subscription behavior', () => {
  const mockExtractSubscriptionServer = extract_subscription_server as jest.MockedFunction<typeof extract_subscription_server>;
  const mockCreateSubscription = create_subscription as jest.MockedFunction<typeof create_subscription>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes using the full derived-resource stream URL as topic', async () => {
    const derivedStream = 'http://localhost:3000/alice/health/derived/heart-rate/?source=/alice/raw/hr/&window=PT1M';
    const mockLogger = { info: jest.fn(), error: jest.fn() };
    const mockRspEngine = {
      getStream: jest.fn().mockReturnValue(undefined),
    } as any;

    jest.spyOn(NotificationStreamProcessor.prototype, 'fetchAuthorizedTokenAndInitialize')
      .mockResolvedValue(undefined);

    mockExtractSubscriptionServer.mockResolvedValue({
      location: 'http://localhost:3000/.notifications/WebhookChannel2023/',
      channelType: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      channelLocation: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
    });
    mockCreateSubscription.mockResolvedValue('ok');

    const processor = new NotificationStreamProcessor(
      derivedStream,
      mockLogger,
      mockRspEngine,
      new EventEmitter(),
    );

    await processor.subscribe_webhook_events();

    expect(mockExtractSubscriptionServer).toHaveBeenCalledWith(derivedStream);
    expect(mockCreateSubscription).toHaveBeenCalledWith(
      'http://localhost:3000/.notifications/WebhookChannel2023/',
      derivedStream,
    );
    expect(mockLogger.info).toHaveBeenCalledWith({}, 'subscription_to_ldes_stream_was_successful');
  });
});
