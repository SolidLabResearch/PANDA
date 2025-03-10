export class TokenManager {
    private authorized_access_token: string;
    private authorized_token_type: string;

    constructor() {
        this.authorized_access_token = "";
        this.authorized_token_type = "";
    }

    getAccessToken() {
        if (this.authorized_access_token !== '' && this.authorized_token_type !== '') {
            return {
                access_token: this.authorized_access_token,
                token_type: this.authorized_token_type
            };
        }
        else {
            throw new Error("The access token is not set for the user and the resource which is empty");
        }
    }

    setAccessToken(access_token: any, token_type: any) {
        if (this.authorized_access_token === '' && this.authorized_token_type === '') {
            this.authorized_access_token = access_token;
            this.authorized_token_type = token_type;
        }
        else {
            throw new Error("The access token is already set for the user.");
        }
    }


}