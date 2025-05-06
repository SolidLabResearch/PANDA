class TokenManagerService {
    private static instance: TokenManagerService;
    
    // A map to store access tokens for different URLs
    private accessTokenCache: Map<string, { access_token: string, token_type: string }> = new Map();
    
    // A map to store RPTs based on ticket
    private rptCache: Map<string, { access_token: string, token_type: string }> = new Map();

    // Private constructor to prevent direct instantiation
    private constructor() {}

    // Singleton pattern to ensure only one instance of TokenManagerService is created
    public static getInstance(): TokenManagerService {
        if (!TokenManagerService.instance) {
            TokenManagerService.instance = new TokenManagerService();
        }
        return TokenManagerService.instance;
    }

    /**
     * Store the access token for a given URL.
     * @param url The URL for which the access token is being stored.
     * @param access_token The access token.
     * @param token_type The type of the access token (e.g., 'Bearer').
     */
    public setAccessToken(url: string, access_token: string, token_type: string): void {
        this.accessTokenCache.set(url, { access_token, token_type });
    }

    /**
     * Retrieve the stored access token for a given URL.
     * @param url The URL for which the access token is being retrieved.
     * @returns An object containing the access_token and token_type.
     * @throws Will throw an error if no access token is found for the given URL.
     */
    public getAccessToken(url: string): { access_token: string, token_type: string } {
        const token = this.accessTokenCache.get(url);
        if (!token) {
            throw new Error(`Access token not found for URL: ${url}`);
        }
        return token;
    }

    /**
     * Store the RPT (Requesting Party Token) for a given ticket.
     * @param ticket The ticket associated with the RPT.
     * @param rpt The RPT, consisting of access_token and token_type.
     */
    public setRPT(ticket: string, rpt: { access_token: string, token_type: string }): void {
        this.rptCache.set(ticket, rpt);
    }

    /**
     * Retrieve the RPT for a given ticket.
     * @param ticket The ticket associated with the RPT.
     * @returns The RPT.
     * @throws Will throw an error if no RPT is found for the given ticket.
     */
    public getRPT(ticket: string): { access_token: string, token_type: string } {
        const rpt = this.rptCache.get(ticket);
        if (!rpt) {
            throw new Error(`RPT not found for ticket: ${ticket}`);
        }
        return rpt;
    }

    /**
     * Remove the access token for a given URL (for invalidation or expiration purposes).
     * @param url The URL for which the access token is being removed.
     */
    public removeAccessToken(url: string): void {
        this.accessTokenCache.delete(url);
    }

    /**
     * Remove the RPT for a given ticket (for invalidation or expiration purposes).
     * @param ticket The ticket associated with the RPT.
     */
    public removeRPT(ticket: string): void {
        this.rptCache.delete(ticket);
    }
}

export { TokenManagerService };
