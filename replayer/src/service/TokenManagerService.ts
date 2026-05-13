export class TokenManagerService {
    private static instance: TokenManagerService;

    private containerTokens: Map<string, { access_token: string, token_type: string }>;

    private constructor() {
        this.containerTokens = new Map();
    }

    /**
     * Global process-wide singleton used by all fetchers/replayers.
     * Cache keys are exact container URLs, so token state is shared only for matching URLs.
     */
    public static getInstance(): TokenManagerService {
        if (!TokenManagerService.instance) {
            TokenManagerService.instance = new TokenManagerService();
        }
        return TokenManagerService.instance;
    }

    /**
     * Get access token info for a specific container
     */
    getAccessToken(containerUrl: string): { access_token: string | undefined, token_type: string | undefined } {
        const tokenInfo = this.containerTokens.get(containerUrl);
        if (tokenInfo) {
            return {
                access_token: tokenInfo.access_token,
                token_type: tokenInfo.token_type
            };
        } else {
            console.log(`Access token not found for container: ${containerUrl}`);
            return { access_token: undefined, token_type: undefined };
        }
    }

    /**
     * Set or refresh access token info for a specific container.
     * UMA tokens can be rejected/rotated during a long replay, so replacement must be allowed.
     */
    setAccessToken(containerUrl: string, access_token: string, token_type: string): void {
        this.containerTokens.set(containerUrl, { access_token, token_type });
    }

    /**
     * Optionally clear tokens for a container (or all)
     */
    clearAccessToken(containerUrl?: string): void {
        if (containerUrl) {
            this.containerTokens.delete(containerUrl);
        } else {
            this.containerTokens.clear();
        }
    }
}
