import { resolveNotificationTopic } from './NotificationTopicResolver';

describe('HTTPServer notification topic resolution', () => {
  it('uses webhook topic when present', () => {
    const topic = resolveNotificationTopic(
      { topic: 'http://localhost:3000/alice/derived/acc-x/' },
      'http://localhost:3000/alice/acc-x/1712832000/'
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/acc-x/');
  });

  it('falls back to target parent when topic is missing', () => {
    const topic = resolveNotificationTopic(
      {},
      'http://localhost:3000/alice/acc-x/1712832000/'
    );

    expect(topic).toBe('http://localhost:3000/alice/acc-x/');
  });
});
