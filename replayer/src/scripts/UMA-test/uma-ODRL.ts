import { sleep } from "@treecg/versionawareldesinldp";
import { ReuseTokenUMAFetcher } from "../../fetcher/ReuseTokenUMAFetcher";
import { UserManagedAccessFetcher } from "../../fetcher/UserManagedAccessFetcher";

const resource = "http://n063-02b.wall2.ilabt.iminds.be:3000/alice/acc-x/"
const claim_token = "http://n063-04b.wall2.ilabt.iminds.be/replayer#me"
// const claim_token = "https://woslabbi.pod.knows.idlab.ugent.be/profile/card#me"
const claim_token_format = 'urn:solidlab:uma:claims:formats:webid'
// const fetcher = new UserManagedAccessFetcher({ token: claim_token, token_format: claim_token_format });
const fetcher = new ReuseTokenUMAFetcher({ token: claim_token, token_format: claim_token_format });
async function main() {
    console.log(`Testing UMA flow using UMA Fetcher\n`);

    // const response = await fetcher.fetch(resource, {
    //     method: 'POST',
    //     headers: {
    //         'Content-Type': 'text/turtle',
    //     },
    //     body: '<> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Dummy> .'
    // });


    // console.log(response.headers);

    await fetcher.preAuthorize(resource);
    console.log(`Pre-authorizing resource ${resource} using UMA Fetcher\n`);


    for (let i = 0; i < 10; i++) {
        const response = await fetcher.fetch(resource, {
            method: "POST",
            body: "some text"
        })

        sleep(500);
    }



    // console.log(`Creating document with RPT, expecting HTTP status in 200 range: ${response.status}\n`);

    // const anonymousResponse = await fetch(resource)
    // console.log(`Reading document without RPT, expecting HTTP status in 400 range: ${anonymousResponse.status}\n`);

    // const readingResponse = await fetcher.fetch(resource)

    // console.log(`Reading document with RPT, expecting the content written away: ${await readingResponse.text()}\n`);
}

main()


async function token() {
    const response = await fetch("http://n063-02b.wall2.ilabt.iminds.be:3000/alice/acc-x/", {
        method: "POST",
        body: "some text",
        headers: {
            'Authorization': 'Bearer eyJhbGciOiJFUzI1NiJ9.eyJwZXJtaXNzaW9ucyI6W3sicmVzb3VyY2VfaWQiOiJodHRwOi8vbjA2My0wMmIud2FsbDIuaWxhYnQuaW1pbmRzLmJlOjMwMDAvYWxpY2UvYWNjLXgvIiwicmVzb3VyY2Vfc2NvcGVzIjpbInVybjpleGFtcGxlOmNzczptb2RlczphcHBlbmQiXX1dLCJpYXQiOjE3NDQ4MDA2NzUsImlzcyI6Imh0dHA6Ly9uMDYzLTAzYS53YWxsMi5pbGFidC5pbWluZHMuYmU6NDAwMC91bWEiLCJhdWQiOiJzb2xpZCIsImV4cCI6MTc0NDgwMDk3NSwianRpIjoiYjY3NjljOGMtNTI4NC00Y2MyLWFlNzctNTc3MGFiNWYwMTc5In0.-KwriQX8OIET6M4sXTopQP0pym4zda44yKHMBFa0Z2UKKWGVfmZPhRmGGJHDoQlKwMU1p6omsi5wAu4V79YYfQ'
        }
    });
}
