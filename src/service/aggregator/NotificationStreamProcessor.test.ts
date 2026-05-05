import { EventEmitter } from 'events';
import { NotificationStreamProcessor } from './NotificationStreamProcessor';
import { create_subscription, extract_subscription_server } from '../../utils/notifications/Util';
import { turtleStringToStore } from '@treecg/ldes-snapshot';

jest.mock('@treecg/ldes-snapshot', () => ({
  turtleStringToStore: jest.fn(),
}));

jest.mock('../../utils/notifications/Util', () => ({
  create_subscription: jest.fn(),
  extract_subscription_server: jest.fn(),
  extract_ldp_inbox: jest.fn(),
}));

describe('NotificationStreamProcessor subscription behavior', () => {
  const mockExtractSubscriptionServer = extract_subscription_server as jest.MockedFunction<typeof extract_subscription_server>;
  const mockCreateSubscription = create_subscription as jest.MockedFunction<typeof create_subscription>;
  const mockTurtleStringToStore = turtleStringToStore as jest.MockedFunction<typeof turtleStringToStore>;

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

  it('ingests events emitted on the derived/latest alias into the original RSP stream', async () => {
    const sourceStream = 'http://localhost:3000/alice/spo2/';
    const eventEmitter = new EventEmitter();
    const streamAdd = jest.fn();
    const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const mockRspEngine = {
      getStream: jest.fn().mockReturnValue({ name: sourceStream, add: streamAdd }),
    } as any;
    const latestEventStore = {
      getQuads: jest.fn((subject: any, predicate: any) => {
        const timestampPredicate = 'https://saref.etsi.org/core/hasTimestamp';
        const hasValuePredicate = 'https://saref.etsi.org/core/hasValue';
        const eventSubject = { value: 'http://localhost:3000/alice/spo2/event-1' };
        const quads = [
          {
            subject: eventSubject,
            predicate: { value: timestampPredicate },
            object: {
              value: '2026-05-05T12:00:00.000Z',
              datatype: { value: 'http://www.w3.org/2001/XMLSchema#dateTime' },
              termType: 'Literal',
            },
          },
          {
            subject: eventSubject,
            predicate: { value: hasValuePredicate },
            object: {
              value: '85',
              datatype: { value: 'http://www.w3.org/2001/XMLSchema#integer' },
              termType: 'Literal',
            },
          },
        ];

        if (!predicate) {
          return quads;
        }

        return quads.filter((quad) => quad.predicate.value === predicate.value && (!subject || quad.subject.value === subject.value));
      }),
    };

    jest.spyOn(NotificationStreamProcessor.prototype, 'fetchAuthorizedTokenAndInitialize')
      .mockResolvedValue(undefined);
    mockTurtleStringToStore.mockResolvedValue(latestEventStore as any);

    const processor = new NotificationStreamProcessor(
      sourceStream,
      mockLogger,
      mockRspEngine,
      eventEmitter,
    );

    await processor.retrieve_notification_from_server(eventEmitter);

    eventEmitter.emit('http://localhost:3000/alice/derived/latest', `
      <http://localhost:3000/alice/spo2/event-1>
        <https://saref.etsi.org/core/hasTimestamp> "2026-05-05T12:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
        <https://saref.etsi.org/core/hasValue> "85"^^<http://www.w3.org/2001/XMLSchema#integer> .
    `);

    await new Promise(process.nextTick);

    expect(mockTurtleStringToStore).toHaveBeenCalled();
    expect(streamAdd).toHaveBeenCalledTimes(2);
    expect(streamAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        predicate: expect.objectContaining({ value: 'https://saref.etsi.org/core/hasTimestamp' }),
      }),
      Date.parse('2026-05-05T12:00:00.000Z'),
    );
  });
});
