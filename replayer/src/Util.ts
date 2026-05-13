import { LDPCommunication } from "@treecg/versionawareldesinldp";
import axios from "axios";
const N3 = require('n3');
const { DataFactory } = N3;
const { namedNode } = DataFactory;

export async function extract_ldp_inbox(ldes_stream_location: string) {
    const parser = new N3.Parser();
    const store = new N3.Store();
    try {
        const response = await axios.get(ldes_stream_location);
        if (response) {
            await parser.parse(response.data, (error: any, quad: any) => {
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

export async function create_ldp_container(url_to_create: string, communication: LDPCommunication) {
    if (url_to_create.endsWith("/")) {
        const response = await communication.put(url_to_create);
        if (response.status != 201) {
            return false;
        }
    } else {
        return true;
    }
}

export async function update_latest_inbox(latest_container_url: string) {
    const last_index = latest_container_url.lastIndexOf("/");
    const ldes_location = latest_container_url.substring(0, last_index);
    const response = await axios.patch(ldes_location, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/sparql-update'
        },
        body: `INSERT DATA { <${ldes_location}> <http://www.w3.org/ns/ldp#inbox> <${latest_container_url}> }`
    });
    if (response.status !== 200) {
        throw new Error(`Could not update the latest inbox with status code ${response.status}`);
    }
    else {
        console.log(`Successfully updated the latest inbox to ${latest_container_url}`);
    }
}   