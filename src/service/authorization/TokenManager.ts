export class TokenManager {
    private static instance: TokenManager;
    private authorized_access_token: string | undefined;
    private authorized_token_type: string | undefined;

    constructor() {
        this.authorized_access_token = undefined
        this.authorized_token_type = undefined
    }


    public static getInstance(): TokenManager {
        if (!TokenManager.instance){
            TokenManager.instance = new TokenManager();
        }
        return TokenManager.instance;
    }

    getAccessToken() {
        if (this.authorized_access_token && this.authorized_token_type) {
            return {
                access_token: this.authorized_access_token,
                token_type: this.authorized_token_type
            };
        }
        else {
            console.log("The access token is not set for the user and the resource which is empty");
            return { access_token: undefined, token_type: undefined };
        }
    }

    setAccessToken(access_token: any, token_type: any) {
        if (this.authorized_access_token === undefined && this.authorized_token_type === undefined) {
            this.authorized_access_token = access_token;
            this.authorized_token_type = token_type;
        }
        else {
            console.error("The access token is already set for the user.");
        }
    }


}