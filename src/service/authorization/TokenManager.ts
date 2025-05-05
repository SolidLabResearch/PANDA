export class TokenManagerService {
    private static instance: TokenManagerService;

    // Map<containerUrl, Map<httpMethod, tokenInfo>>
    private containerTokens: Map<string, Map<string, { access_token: string, token_type: string }>>;

    private constructor() {
        this.containerTokens = new Map();
    }

    public static getInstance(): TokenManagerService {
        if (!TokenManagerService.instance) {
            TokenManagerService.instance = new TokenManagerService();
        }
        return TokenManagerService.instance;
    }

    /**
     * Get access token info for a specific container and HTTP method
     */
    getAccessToken(containerUrl: string, method: string ): { access_token: string | undefined, token_type: string | undefined } {
        const methodUpper = method.toUpperCase();
        const methodMap = this.containerTokens.get(containerUrl);

        if (methodMap) {
            const tokenInfo = methodMap.get(methodUpper);
            if (tokenInfo) {
                return {
                    access_token: tokenInfo.access_token,
                    token_type: tokenInfo.token_type
                };
            }
        }
        console.log(`Access token not found for container: ${containerUrl}, method: ${methodUpper}`);
        return { access_token: undefined, token_type: undefined };
    }

    /**
     * Set access token info for a specific container and HTTP method
     */
    setAccessToken(containerUrl: string, method: string, access_token: string, token_type: string): void {
        const methodUpper = method.toUpperCase();
        if (!this.containerTokens.has(containerUrl)) {
            this.containerTokens.set(containerUrl, new Map());
        }

        const methodMap = this.containerTokens.get(containerUrl)!;

        if (!methodMap.has(methodUpper)) {
            methodMap.set(methodUpper, { access_token, token_type });
        } else {
            console.error(`Access token already set for container: ${containerUrl}, method: ${methodUpper}`);
        }
    }

    /**
     * Clear tokens — either for a specific method, or all methods of a container, or all containers
     */
    clearAccessToken(containerUrl?: string, method?: string): void {
        if (containerUrl && method) {
            const methodMap = this.containerTokens.get(containerUrl);
            if (methodMap) {
                methodMap.delete(method.toUpperCase());
            }
        } else if (containerUrl) {
            this.containerTokens.delete(containerUrl);
        } else {
            this.containerTokens.clear();
        }
    }
}
