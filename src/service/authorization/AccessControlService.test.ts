import { AccessControlService } from "./AccessControlService";

describe(`AccessControlService`, () => {
    let access_control_service: AccessControlService;


    test('testing the authorization of a request', async () => {
        let requesting_user = `http://n063-08a.wall2.ilabt.iminds.be:8080/profile/card#me`;
        let patient_webID = `http://n063-02b.wall2.ilabt.iminds.be:3000/pod1/profile/card#me`;
        let requested_resource = `http://n063-02b.wall2.ilabt.iminds.be:3000/pod1/acc-x/`;
        let access_control_service = new AccessControlService(requesting_user, requested_resource, patient_webID);
        let purposeForAccess = `http://example.org/aggregation`;
        let legalBasis = `https://w3id.org/dpv/legal/eu/gdpr#A9-2-a`;
        let result = await access_control_service.authorizeRequest(purposeForAccess, legalBasis);
        console.log(result);
    }); 

    test('testing the authentication of a request', async () => {
        
    });
});