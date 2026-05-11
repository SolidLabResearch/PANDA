function normalizeTopic(urlLike: string): string | undefined {
    try {
        const normalized = new URL(urlLike);
        normalized.hash = '';
        normalized.search = '';
        return normalized.toString();
    } catch {
        return undefined;
    }
}

function inferDerivedLatestTopicFromTarget(target: string): string | undefined {
    try {
        const parsed = new URL(target);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length === 0) {
            return undefined;
        }
        const podOwner = segments[0];
        parsed.hash = '';
        parsed.search = '';
        parsed.pathname = `/${podOwner}/derived/latest`;
        return parsed.toString();
    } catch {
        return undefined;
    }
}

export function resolveNotificationTopic(webhook_notification_data: any, target?: string, allowExactTopic: boolean = false): string | undefined {
    if (typeof webhook_notification_data?.topic === 'string' && webhook_notification_data.topic.length > 0) {
        const explicitTopic = normalizeTopic(webhook_notification_data.topic) ?? webhook_notification_data.topic;
        if (allowExactTopic && webhook_notification_data?.use_exact_topic === true) {
            return explicitTopic;
        }
        // For source-stream notifications, always consume through the derived/latest endpoint.
        const inferredFromTopic = inferDerivedLatestTopicFromTarget(explicitTopic);
        if (inferredFromTopic) {
            return inferredFromTopic;
        }
        return explicitTopic;
    }
    const fallbackSource = typeof webhook_notification_data?.object === 'string' && webhook_notification_data.object.length > 0
        ? webhook_notification_data.object
        : target;
    if (!fallbackSource) {
        return undefined;
    }

    return inferDerivedLatestTopicFromTarget(fallbackSource);
}
