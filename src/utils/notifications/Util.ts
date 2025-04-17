import axios from 'axios';
import { SubscriptionServerNotification } from '../Types';
import * as AGGREGATOR_SETUP from '../../config/aggregator_setup.json';
const N3 = require('n3');
const parser = new N3.Parser();
import { TokenManagerService } from '../../service/authorization/TokenManager';
const token_manager = TokenManagerService.getInstance();
/**
 * Extracts the subscription server from the given resource.
 * @param {string} resource - The resource which you want to read the notifications from.
 * @returns {Promise<SubscriptionServerNotification | undefined>} - A promise which returns the subscription server or if not returns undefined.
 */
export async function extract_subscription_server(resource: string): Promise<SubscriptionServerNotification | undefined> {
    /**
    * Hardcoding now. 
    * Note to self that for notification protocol you need to have authorization to read the subscription server.
    */
    const subscription_server = "http://n063-02b.wall2.ilabt.iminds.be:3000/.notifications/WebhookChannel2023/";
    const subscription_type = "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023";
    const channelLocation = "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023";

    const subscription_response: SubscriptionServerNotification = {
        location: subscription_server,
        channelType: subscription_type,
        channelLocation: channelLocation
    }
    return subscription_response;

    const store = new N3.Store();
    try {
        const { access_token, token_type } = token_manager.getAccessToken(resource);
        console.log(access_token, token_type);

        const response = await axios.head(resource, {
            headers: {
                'Authorization': `${token_type} ${access_token}` // Add the access token to the headers.
            }
        });
        const link_header = response.headers['link'];
        if (link_header) {
            const link_header_parts = link_header.split(',');
            for (const part of link_header_parts) {
                const [link, rel] = part.split(';').map((item: string) => item.trim());
                if (rel === 'rel="http://www.w3.org/ns/solid/terms#storageDescription"') {
                    const storage_description_link = link.slice(1, -1); // remove the < and >\
                    const storage_description_response = await axios.get(storage_description_link);
                    const storage_description = storage_description_response.data;
                    await parser.parse(storage_description, (error: any, quad: any) => {
                        if (quad) {
                            store.addQuad(quad);
                        }
                    });
                    /**
                     * Hardcoding now. 
                     * Note to self that for notification protocol you need to have authorization to read the subscription server.
                     */
                    const subscription_server = "http://n063-02b.wall2.ilabt.iminds.be:3000/.notifications/WebhookChannel2023/";
                    const subscription_type = "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023";
                    const channelLocation = "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023";
                    // const subscription_server = store.getQuads(null, 'http://www.w3.org/ns/solid/notifications#subscription', null)[0].object.value;
                    // const subscription_type = store.getQuads(null, 'http://www.w3.org/ns/solid/notifications#channelType', null)[0].object.value;
                    // const channelLocation = store.getQuads(null, 'http://www.w3.org/ns/solid/notifications#channelType', null)[0].subject.value;
                    const subscription_response: SubscriptionServerNotification = {
                        location: subscription_server,
                        channelType: subscription_type,
                        channelLocation: channelLocation
                    }
                    return subscription_response;
                }
                else {
                    continue;
                }
            }
        }
    } catch (error) {
        throw new Error("Error while extracting subscription server.");
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
        const { access_token, token_type } = token_manager.getAccessToken(ldes_stream_location);
        const response = await fetch(ldes_stream_location, {
            headers: {
                'Authorization': `${token_type} ${access_token}` // Add the access token to the headers.
            }
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
        else {
            throw new Error("The response object is empty.");
        }
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
export async function create_subscription(subscription_server: string, inbox_location: string) {
    try {
        const subscription = {
            "@context": ["https://www.w3.org/ns/solid/notification/v1"],
            "type": "http://www.w3.org/ns/solid/notifications#WebhookChannel2023",
            "topic": `${inbox_location}`,
            "sendTo": `${AGGREGATOR_SETUP.aggregator_http_server_url}`,
        }
        const { access_token, token_type } = token_manager.getAccessToken(inbox_location)
        const response = await fetch(subscription_server, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/ld+json',
                'Authorization': `${token_type} ${access_token}` // Add the access token to the headers.
            },
            body: JSON.stringify(subscription)
        })
        if (response) {
            return response.text();
        }
        else {
            console.error("The response object is empty.");
            throw new Error("The response object is empty.");
        }
    } catch (error) {
        throw new Error("Error while creating subscription.");
    }
}
