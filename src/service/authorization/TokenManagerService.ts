export class TokenManagerService {
    private static instance: TokenManagerService;

    private containerTokens: Map<string, { access_token: string, token_type: string }>;

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
     * Set access token info for a specific container
     */
    setAccessToken(containerUrl: string, access_token: string, token_type: string): void {
        if (!this.containerTokens.has(containerUrl)) {
            this.containerTokens.set(containerUrl, { access_token, token_type });
        } else {
            console.error(`Access token already set for container: ${containerUrl}`);
        }
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
