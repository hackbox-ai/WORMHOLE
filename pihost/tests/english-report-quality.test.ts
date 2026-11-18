import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessmentFields,checkFindingReport} from '../src/domains/findings/report-quality.ts';
const assessment=Object.fromEntries(assessmentFields.map(k=>[k,'Verified against the recorded evidence.']));
const report=`# Finding
## Overview
The test account changed the recorded object.
## Prerequisites
Use the owned test account and a fresh object.
## Reproduction Steps
Repeat the recorded request with a valid session.
## Evidence
Observed before=1, after=2 in source:1.
## Verified Impact and Limitations
Only this object was tested. Other identities remain unverified.
## Root Cause
Missing state validation; the code-level cause is inferred.
## Remediation
Validate object ownership and state transitions on the server.
## Retest and Acceptance Criteria
Repeat from a fresh object; reject invalid transitions and preserve its state.`;
const check=(text:string)=>checkFindingReport(text,assessment,['source:1'],new Set(['source:1']),[]);
test('complete English reports satisfy section requirements',()=>assert.equal(check(report).passed,true));
test('English reports require substantive reproduction and retest sections',()=>{
 assert.equal(check(report.replace(/## Retest and Acceptance Criteria[\s\S]*/, '')).passed,false);
 assert.equal(check(report.replace(/## Reproduction Steps\n[^\n]+/, '## Reproduction Steps')).passed,false);
});
test('English impact checks reject unsupported unlimited and arbitrary-account claims',()=>{
 assert.equal(check(report.replace('Only this object was tested.', 'Unlimited refunds are possible.')).passed,false);
 const text=report.replace('Only this object was tested. Other identities remain unverified.', 'All tenants are affected.\nCross-tenant testing is unverified.');
 assert.equal(check(text).passed,false);
});
