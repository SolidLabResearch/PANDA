import { Parser, Quad } from "n3";
import jsonld from "jsonld";

export type RdfGetResult = {
    triples: Quad[];
    response: Response;
};

type RdfRequestInit = RequestInit & {
    Headers?: HeadersInit;
};

export class RdfHttpClient {
    public async get(url: string, init: RdfRequestInit = {}): Promise<RdfGetResult> {
        const requestedHeaders = (init.headers ?? init.Headers) as HeadersInit | undefined;
        const headers = new Headers(requestedHeaders ?? {});

        if (!headers.has("accept")) {
            headers.set("accept", "text/turtle, application/ld+json;q=0.9, application/n-triples;q=0.8, application/trig;q=0.7, text/n3;q=0.6, */*;q=0.1");
        }

        const response = await fetch(url, {
            ...init,
            headers,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch RDF from ${url}: ${response.status} ${response.statusText}`);
        }

        const body = await response.text();
        if (body.length === 0) {
            return { triples: [], response };
        }

        const contentType = (response.headers.get("content-type") || "").toLowerCase();

        if (contentType.includes("application/ld+json") || contentType.includes("application/json")) {
            const nquads = (await jsonld.toRDF(JSON.parse(body), {
                base: url,
                format: "application/n-quads",
            })) as unknown as string;
            const parser = new Parser({ format: "application/n-quads", baseIRI: url });
            return { triples: parser.parse(nquads), response };
        }

        const format = this.resolveN3Format(contentType);
        const parser = new Parser({ format, baseIRI: url });
        return { triples: parser.parse(body), response };
    }

    private resolveN3Format(contentType: string): string {
        if (contentType.includes("application/n-triples")) {
            return "application/n-triples";
        }
        if (contentType.includes("application/n-quads")) {
            return "application/n-quads";
        }
        if (contentType.includes("application/trig")) {
            return "application/trig";
        }
        if (contentType.includes("text/n3")) {
            return "text/n3";
        }
        return "text/turtle";
    }
}
