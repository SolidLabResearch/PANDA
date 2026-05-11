import { resolveNotificationTopic } from './NotificationTopicResolver';

describe('HTTPServer notification topic resolution', () => {
  it('uses webhook topic when present', () => {
    const topic = resolveNotificationTopic(
      { topic: 'http://localhost:3000/alice/derived/acc-x/' },
      'http://localhost:3000/alice/acc-x/1712832000/'
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/latest');
  });

  it('keeps exact webhook topic resource when topic has no trailing slash', () => {
    const topic = resolveNotificationTopic(
      { topic: 'http://localhost:3000/alice/derived/latest' },
      'http://localhost:3000/alice/spo2/1712832000/'
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/latest');
  });

  it('falls back to target parent when topic is missing', () => {
    const topic = resolveNotificationTopic(
      {},
      'http://localhost:3000/alice/acc-x/1712832000/'
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/latest');
  });

  it('infers derived/latest from notification object when topic is missing', () => {
    const topic = resolveNotificationTopic(
      { object: 'http://localhost:3000/alice/spo2/99def45a-ed2c-4662-896e-b9a900af1248' },
      'http://localhost:3000/alice/spo2/'
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/latest');
  });

  it('ignores use_exact_topic unless benchmark control explicitly allows it', () => {
    const topic = resolveNotificationTopic(
      {
        topic: 'http://localhost:3000/alice/derived/spo2-last-10-min/',
        use_exact_topic: true,
      },
      'http://localhost:3000/alice/spo2/1712832000/'
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/latest');
  });

  it('uses exact topic when benchmark control allows it', () => {
    const topic = resolveNotificationTopic(
      {
        topic: 'http://localhost:3000/alice/derived/spo2-last-10-min/',
        use_exact_topic: true,
      },
      'http://localhost:3000/alice/spo2/1712832000/',
      true
    );

    expect(topic).toBe('http://localhost:3000/alice/derived/spo2-last-10-min/');
  });
});
