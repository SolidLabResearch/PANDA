    const fs = require('fs');
    // Preflight 1: Verify the actual ODRL policy written
    const metaPolicyPath = path.join(uma.cssStatePath, 'alice/spo2/.meta');
    let policyContents = '';
    try {
        policyContents = fs.readFileSync(metaPolicyPath, 'utf8');
    } catch (e) {
        console.warn(`[DENIAL] Could not read policy at ${metaPolicyPath}: ${e.message}`);
    }
    const requestedActorWebId = scenario.panda_query_payload?.actor_webid || '';
    raw.unauthorized_actor_webid = requestedActorWebId;
    raw.requested_actor_webid = requestedActorWebId;
    raw.unauthorized_actor_present_in_policy = policyContents.includes(requestedActorWebId);
    
    if (raw.unauthorized_actor_present_in_policy) {
        console.error(`[DENIAL] FATAL: Unauthorized actor ${requestedActorWebId} is present in the ODRL policy!`);
        raw.scenario_passed = false;
        raw.output_check = { passed: false, details: { reason: 'Unauthorized actor found in ODRL policy' } };
        writeJson(rawPath, raw);
        writeJson(failurePath, raw);
        if (!opts.continueOnFailure) throw new Error('Unauthorized actor present in policy');
    }

    // Preflight 2: Public access check
    const targetUrl = scenario.target_css_resources?.stream_container_url;
    console.log(`[DENIAL] Checking public readability of ${targetUrl}`);
    let publicRes;
    try {
        publicRes = await fetch(targetUrl);
    } catch (e) {
        console.warn(`[DENIAL] Public GET failed: ${e.message}`);
    }
    raw.public_get_status = publicRes ? publicRes.status : null;
    raw.public_get_returned_protected_content = publicRes ? publicRes.status === 200 : false;
    raw.resource_publicly_readable = raw.public_get_returned_protected_content;

    if (raw.resource_publicly_readable) {
        console.error(`[DENIAL] FATAL: Target resource ${targetUrl} is publicly readable (status 200)!`);
        raw.scenario_passed = false;
        raw.output_check = { passed: false, details: { reason: 'Resource is publicly readable' } };
        writeJson(rawPath, raw);
        writeJson(failurePath, raw);
        if (!opts.continueOnFailure) throw new Error('Resource is publicly readable');
    }

    // Preflight 3: Direct Jim access attempt (if possible)
    raw.direct_jim_access_tested = false;
    raw.direct_jim_access_status = null;
    raw.direct_jim_content_returned = null;
    try {
        const parsedChallenge = await fetch(targetUrl).then(res => {
            if (res.status === 401) {
                return parseAuthenticateHeader(res.headers.get('WWW-Authenticate'));
            }
            return null;
        });
        
        if (parsedChallenge) {
            console.log(`[DENIAL] Attempting direct token exchange for Jim...`);
            const jimToken = await exchangeToken(parsedChallenge.tokenEndpoint, parsedChallenge.ticket, requestedActorWebId, 'urn:solidlab:uma:claims:formats:webid');
            raw.direct_jim_access_tested = true;
            
            const jimRes = await fetch(targetUrl, {
                headers: { Authorization: `${jimToken.tokenType} ${jimToken.accessToken}` }
            });
            raw.direct_jim_access_status = jimRes.status;
            raw.direct_jim_content_returned = jimRes.status === 200;
            
            if (raw.direct_jim_content_returned) {
                console.error(`[DENIAL] FATAL: Jim was able to directly access ${targetUrl} via token exchange!`);
            }
        } else {
             console.log(`[DENIAL] Could not test direct Jim access: no UMA challenge returned.`);
        }
    } catch (e) {
        raw.direct_jim_access_tested = true;
        console.log(`[DENIAL] Direct Jim access failed as expected: ${e.message}`);
    }
    
    if (raw.direct_jim_content_returned) {
        raw.scenario_passed = false;
        raw.output_check = { passed: false, details: { reason: 'Direct token exchange granted access to unauthorized actor' } };
        writeJson(rawPath, raw);
        writeJson(failurePath, raw);
        if (!opts.continueOnFailure) throw new Error('Direct Jim access succeeded');
    }

