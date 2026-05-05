import { SubscriptionServerNotification } from '../Types';
import * as AGGREGATOR_SETUP from '../../config/aggregator_setup.json';
import { TokenManagerService } from '../../service/authorization/TokenManagerService';
import { ReuseTokenUMAFetcher } from '../../service/authorization/ReuseTokenUMAFetcher';
import { getUmaClaim } from '../../config/UmaClaim';

const N3 = require('n3');
const parser = new N3.Parser();
const token_manager = TokenManagerService.getInstance();
const uma_fetcher = new ReuseTokenUMAFetcher(getUmaClaim());

/**
 * Extracts the subscription server from the given resource.
 * @param {string} resource - The resource which you want to read the notifications from.
 * @returns {Promise<SubscriptionServerNotification | undefined>} - A promise which returns the subscription server or if not returns undefined.
 */
export async function extract_subscription_server(resource: string): Promise<SubscriptionServerNotification | undefined> {
    const store = new N3.Store();
    const fallbackFromResource = (resourceUrl: string): SubscriptionServerNotification | undefined => {
        try {
            const origin = new URL(resourceUrl).origin;
            const fallback = `${origin}/.notifications/WebhookChannel2023/`;
            return {
                location: fallback,
                channelType: 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023',
                channelLocation: fallback,
            };
        } catch (fallbackError) {
            console.error(`Unable to derive fallback subscription server for ${resourceUrl}.`, fallbackError);
            return undefined;
        }
    };

    try {
        await uma_fetcher.fetch(resource, { method: 'GET' });
        const token = token_manager.getAccessToken(resource);
        const headers: Record<string, string> = {};
        if (token?.token_type && token?.access_token) {
            headers['Authorization'] = `${token.token_type} ${token.access_token}`;
        }

        const response = await fetch(resource, { method: 'HEAD', headers });
        const link_header = response.headers.get('link') ?? undefined;
        if (!link_header) {
            return fallbackFromResource(resource);
        }

        const storage_rel = 'http://www.w3.org/ns/solid/terms#storageDescription';
        let storage_description_link: string | undefined;
        for (const part of link_header.split(',')) {
            const link_match = part.match(/<([^>]+)>/);
            if (link_match && part.includes(`rel="${storage_rel}"`)) {
                storage_description_link = link_match[1];
                break;
            }
        }

        if (!storage_description_link) {
            return fallbackFromResource(resource);
        }

        const resolved_storage_description_link = new URL(storage_description_link, resource).toString();
        const storage_description_response = await fetch(resolved_storage_description_link, { headers });
        if (!storage_description_response.ok) {
            return fallbackFromResource(resource);
        }
        const storage_description_turtle = await storage_description_response.text();
        await parser.parse(storage_description_turtle, (error: any, quad: any) => {
            if (error) {
                throw error;
            }
            if (quad) {
                store.addQuad(quad);
            }
        });

        const subscription_predicate = 'http://www.w3.org/ns/solid/notifications#subscription';
        const channel_type_predicate = 'http://www.w3.org/ns/solid/notifications#channelType';
        const webhook_channel_type = 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023';
        const websocket_channel_type = 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023';

        const subscription_quads = store.getQuads(null, subscription_predicate, null);
        if (!subscription_quads || subscription_quads.length === 0) {
            return fallbackFromResource(resource);
        }

        const resolvedChannels = subscription_quads.map((quad: any) => {
            const rawLocation = quad.object.value as string;
            const location = new URL(rawLocation, resource).toString();
            const channel_type_quad = store.getQuads(rawLocation, channel_type_predicate, null)[0];
            return {
                location,
                channelType: channel_type_quad?.object?.value
                    ?? (rawLocation.includes('WebhookChannel2023') ? webhook_channel_type : websocket_channel_type)
            };
        });

        const selectedChannel = resolvedChannels.find((channel: { location: string; channelType: string }) => channel.channelType === webhook_channel_type)
            ?? resolvedChannels[0];

        const subscription_response: SubscriptionServerNotification = {
            location: selectedChannel.location,
            channelType: selectedChannel.channelType,
            channelLocation: selectedChannel.location
        };
        return subscription_response;
    } catch (error) {
        console.warn(`Failed to extract subscription server from ${resource}. Falling back to default webhook channel.`, error);
        return fallbackFromResource(resource);
    }
}

/**
 * Extracts the inbox location from the given LDES stream location.
 * @param {string} ldes_stream_location - The location of the LDES stream.
 * @returns {Promise<string>} - A promise which returns the inbox location.
 */
export async function extract_ldp_inbox(ldes_stream_location: string) {
    console.log(ldes_stream_location);

    const store = new N3.Store();
    try {
        const response = await uma_fetcher.fetch(ldes_stream_location, {
            headers: {}
        });
        if (response) {
            await parser.parse(await response.text(), (error: any, quad: any) => {
                if (error) {
                    console.error(error);
                    throw new Error("Error while parsing LDES stream.");
                }
                if (quad) {
                    store.addQuad(quad);
                }
            });
            const inbox = store.getQuads(null, 'http://www.w3.org/ns/ldp#inbox', null)[0].object.value;
            return ldes_stream_location + inbox;
        }
        throw new Error("The response object is empty.");
    } catch (error) {
        console.error(error);
    }
}

/**
 * Creates a subscription to the Caching Service's HTTP Server for the given inbox location to read the notifications.
 * @param {string} subscription_server - The subscription server (of the Solid Server) where the subscription will be created.
 * @param {string} inbox_location - The location of the inbox where the notifications are written by the client(s).
 * @returns {Promise<string>} - A promise which returns the response text.
 */
export async function create_subscription(subscription_server: string, location: string) {
    try {
        const subscription = {
            "@context": ["https://www.w3.org/ns/solid/notification/v1"],
            "type": "http://www.w3.org/ns/solid/notifications#WebhookChannel2023",
            "topic": `${location}`,
            "sendTo": `${AGGREGATOR_SETUP.aggregator_http_server_url}`,
        };
        const response = await uma_fetcher.fetch(subscription_server, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/ld+json',
            },
            body: JSON.stringify(subscription)
        });
        if (response.ok) {
            return response.text();
        }
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Subscription request failed (${response.status}): ${errorBody}`);
    } catch (error) {
        console.warn(`Failed to create subscription at ${subscription_server} for ${location}. Continuing without server-side subscription.`, error);
        return '';
    }
}
