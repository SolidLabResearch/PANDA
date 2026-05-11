const fs = require('fs');
const path = require('path');

const BENCHMARK_NAME = 'odrl-policy-graph-size';
const POLICY_COUNTS = [1, 5, 10, 25, 50, 100];
const MATCHING_POLICY_UID = 'urn:panda:benchmark:policy:matching-spo2-read';

const DEFAULT_OWNER_WEBID = 'http://localhost:3000/alice/profile/card#me';
const DEFAULT_REQUESTER_WEBID = 'http://localhost:3000/bob/profile/card#me';
const DEFAULT_TARGET = 'http://localhost:3000/alice/spo2/';
const DEFAULT_ACTION = 'read';

const DISTRACTOR_TARGETS_TYPE_A = [
  'http://localhost:3000/alice/hr/',
  'http://localhost:3000/alice/temperature/',
  'http://localhost:3000/alice/blood-pressure/',
  'http://localhost:3000/alice/respiration-rate/',
  'http://localhost:3000/alice/glucose/',
];

const DISTRACTOR_ASSIGNEES_TYPE_B = [
  'https://caregiver-001.example/profile#me',
  'https://caregiver-002.example/profile#me',
  'https://nurse-001.example/profile#me',
  'https://doctor-001.example/profile#me',
];

const DISTRACTOR_TARGETS_TYPE_C = [
  'http://localhost:3000/bob/spo2/',
  'http://localhost:3000/charlie/spo2/',
  'http://localhost:3000/diana/spo2/',
  'http://localhost:3000/patient-001/spo2/',
  'http://localhost:3000/patient-002/spo2/',
];

const DISTRACTOR_TARGETS_TYPE_D = [
  'http://localhost:3000/alice/derived/anomaly-alert/',
  'http://localhost:3000/alice/derived/spo2-alert/',
  'http://localhost:3000/alice/derived/monitoring-summary/',
  'http://localhost:3000/alice/derived/risk-score/',
  'http://localhost:3000/alice/derived/caregiver-notification/',
];

const DISTRACTOR_ACTIONS_TYPE_E = [ 'write', 'append', 'create', 'delete' ];

function padPolicyCount(count) {
  return String(count).padStart(3, '0');
}

function generatedPolicyDirectory(repoRoot) {
  return path.join(repoRoot, 'benchmarks', 'generated', BENCHMARK_NAME);
}

function generatedPolicyFilePath(repoRoot, benchmarkPolicyCount) {
  return path.join(
    generatedPolicyDirectory(repoRoot),
    `policies-${padPolicyCount(benchmarkPolicyCount)}.ttl`
  );
}

function generatedManifestPath(repoRoot) {
  return path.join(generatedPolicyDirectory(repoRoot), 'manifest.json');
}

function toOdrlAction(action) {
  if (!action) throw new Error('Missing action.');
  return action.startsWith('odrl:') ? action : `odrl:${action}`;
}

function ensureValidPolicyCount(benchmarkPolicyCount) {
  if (!Number.isInteger(benchmarkPolicyCount) || benchmarkPolicyCount < 1) {
    throw new Error(`Invalid benchmark_policy_count: ${benchmarkPolicyCount}`);
  }
}

function makePermissionId(policyUid) {
  return `${policyUid}#permission`;
}

function makeMatchingPolicy({
  requesterWebId,
  target,
  action,
}) {
  return {
    uid: MATCHING_POLICY_UID,
    permissionId: makePermissionId(MATCHING_POLICY_UID),
    kind: 'matching',
    distractorType: null,
    target,
    assignee: requesterWebId,
    action,
    nonMatchingReason: null,
  };
}

function distractorPolicyUid(type, index) {
  return `urn:panda:benchmark:policy:distractor-${type.toLowerCase()}-${String(index).padStart(3, '0')}`;
}

function makeDistractorPolicy(type, index, fields) {
  const uid = distractorPolicyUid(type, index);
  return {
    uid,
    permissionId: makePermissionId(uid),
    kind: 'distractor',
    distractorType: type,
    target: fields.target,
    assignee: fields.assignee,
    action: fields.action,
    nonMatchingReason: fields.nonMatchingReason,
  };
}

function generateBenchmarkPolicies({
  benchmarkPolicyCount,
  requesterWebId = DEFAULT_REQUESTER_WEBID,
  target = DEFAULT_TARGET,
  action = DEFAULT_ACTION,
  allowTypeE = true,
}) {
  ensureValidPolicyCount(benchmarkPolicyCount);
  const distractorCycle = allowTypeE ? [ 'A', 'B', 'C', 'D', 'E' ] : [ 'A', 'B', 'C', 'D' ];
  const policies = [ makeMatchingPolicy({ requesterWebId, target, action }) ];
  const counters = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  for (let i = 0; i < benchmarkPolicyCount - 1; i += 1) {
    const type = distractorCycle[i % distractorCycle.length];
    counters[type] += 1;
    const sequence = counters[type];
    if (type === 'A') {
      policies.push(makeDistractorPolicy(type, i + 1, {
        target: DISTRACTOR_TARGETS_TYPE_A[(sequence - 1) % DISTRACTOR_TARGETS_TYPE_A.length],
        assignee: requesterWebId,
        action: 'read',
        nonMatchingReason: 'target_mismatch_vital_sign',
      }));
      continue;
    }
    if (type === 'B') {
      policies.push(makeDistractorPolicy(type, i + 1, {
        target,
        assignee: DISTRACTOR_ASSIGNEES_TYPE_B[(sequence - 1) % DISTRACTOR_ASSIGNEES_TYPE_B.length],
        action: 'read',
        nonMatchingReason: 'assignee_mismatch',
      }));
      continue;
    }
    if (type === 'C') {
      policies.push(makeDistractorPolicy(type, i + 1, {
        target: DISTRACTOR_TARGETS_TYPE_C[(sequence - 1) % DISTRACTOR_TARGETS_TYPE_C.length],
        assignee: requesterWebId,
        action: 'read',
        nonMatchingReason: 'target_mismatch_patient',
      }));
      continue;
    }
    if (type === 'D') {
      policies.push(makeDistractorPolicy(type, i + 1, {
        target: DISTRACTOR_TARGETS_TYPE_D[(sequence - 1) % DISTRACTOR_TARGETS_TYPE_D.length],
        assignee: requesterWebId,
        action: 'read',
        nonMatchingReason: 'target_mismatch_derived_resource',
      }));
      continue;
    }
    if (type === 'E') {
      policies.push(makeDistractorPolicy(type, i + 1, {
        target,
        assignee: requesterWebId,
        action: DISTRACTOR_ACTIONS_TYPE_E[(sequence - 1) % DISTRACTOR_ACTIONS_TYPE_E.length],
        nonMatchingReason: 'action_mismatch_non_read',
      }));
      continue;
    }
    throw new Error(`Unsupported distractor type: ${type}`);
  }

  return policies;
}

function countMatchingBenchmarkPolicies(policies, request) {
  return policies.filter((policy) => (
    policy.assignee === request.requester &&
    policy.target === request.target &&
    policy.action === request.action
  )).length;
}

function renderPolicyBlock(policy, ownerWebId) {
  return [
    `<${policy.uid}> a odrl:Agreement ;`,
    `  odrl:uid <${policy.uid}> ;`,
    `  odrl:permission <${policy.permissionId}> .`,
    '',
    `<${policy.permissionId}> a odrl:Permission ;`,
    `  odrl:action ${toOdrlAction(policy.action)} ;`,
    `  odrl:target <${policy.target}> ;`,
    `  odrl:assignee <${policy.assignee}> ;`,
    `  odrl:assigner <${ownerWebId}> .`,
    '',
  ].join('\n');
}

function renderPoliciesTurtle({
  benchmarkPolicyCount,
  ownerWebId = DEFAULT_OWNER_WEBID,
  policies,
}) {
  const header = [
    '@prefix odrl: <http://www.w3.org/ns/odrl/2/> .',
    '',
    '# BEGIN GENERATED PANDA ODRL POLICY GRAPH SIZE BENCHMARK',
    `# benchmark_name: ${BENCHMARK_NAME}`,
    `# benchmark_policy_count: ${benchmarkPolicyCount}`,
    `# generated_at: ${new Date().toISOString()}`,
    '',
  ].join('\n');

  const body = policies.map((policy) => renderPolicyBlock(policy, ownerWebId)).join('\n');
  const footer = [
    '# END GENERATED PANDA ODRL POLICY GRAPH SIZE BENCHMARK',
    '',
  ].join('\n');
  return `${header}${body}${footer}`;
}

function writeGeneratedPolicySet({
  repoRoot,
  benchmarkPolicyCount,
  requesterWebId = DEFAULT_REQUESTER_WEBID,
  target = DEFAULT_TARGET,
  action = DEFAULT_ACTION,
  ownerWebId = DEFAULT_OWNER_WEBID,
  allowTypeE = true,
}) {
  const policies = generateBenchmarkPolicies({
    benchmarkPolicyCount,
    requesterWebId,
    target,
    action,
    allowTypeE,
  });
  const matchingCount = countMatchingBenchmarkPolicies(policies, {
    requester: requesterWebId,
    target,
    action,
  });
  if (matchingCount !== 1) {
    throw new Error(
      `Generated set is invalid for count=${benchmarkPolicyCount}: expected 1 matching benchmark policy, got ${matchingCount}.`
    );
  }

  const outputDir = generatedPolicyDirectory(repoRoot);
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = generatedPolicyFilePath(repoRoot, benchmarkPolicyCount);
  const turtle = renderPoliciesTurtle({
    benchmarkPolicyCount,
    ownerWebId,
    policies,
  });
  fs.writeFileSync(filePath, turtle);
  return {
    filePath,
    benchmarkPolicyCount,
    policies,
    matchingCount,
  };
}

module.exports = {
  BENCHMARK_NAME,
  POLICY_COUNTS,
  MATCHING_POLICY_UID,
  DEFAULT_OWNER_WEBID,
  DEFAULT_REQUESTER_WEBID,
  DEFAULT_TARGET,
  DEFAULT_ACTION,
  padPolicyCount,
  generatedPolicyDirectory,
  generatedPolicyFilePath,
  generatedManifestPath,
  generateBenchmarkPolicies,
  countMatchingBenchmarkPolicies,
  renderPoliciesTurtle,
  writeGeneratedPolicySet,
};
