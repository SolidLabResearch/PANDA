function normalizeTopic(urlLike: string): string | undefined {
    try {
        const normalized = new URL(urlLike);
        normalized.hash = '';
        normalized.search = '';
        if (!normalized.pathname.endsWith('/')) {
            normalized.pathname = normalized.pathname.replace(/[^/]*$/, '');
            if (!normalized.pathname.endsWith('/')) {
                normalized.pathname += '/';
            }
        }
        return normalized.toString();
    } catch {
        return undefined;
    }
}

export function resolveNotificationTopic(webhook_notification_data: any, target?: string): string | undefined {
    if (typeof webhook_notification_data?.topic === 'string' && webhook_notification_data.topic.length > 0) {
        return normalizeTopic(webhook_notification_data.topic) ?? webhook_notification_data.topic;
    }
    if (typeof webhook_notification_data?.object === 'string' && webhook_notification_data.object.length > 0) {
        return normalizeTopic(webhook_notification_data.object) ?? webhook_notification_data.object;
    }
    if (!target) {
        return undefined;
    }

    const normalized = new URL(target);
    normalized.hash = '';
    normalized.search = '';
    normalized.pathname = normalized.pathname.replace(/[^/]*\/?$/, '');
    if (!normalized.pathname.endsWith('/')) {
        normalized.pathname += '/';
    }
    return normalized.toString();
}
