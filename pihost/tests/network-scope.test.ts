import assert from 'node:assert/strict';
import {test} from 'node:test';
import {channelAllows} from '../src/domains/network/channels.ts';
test('channel scopes match exact domains, subdomains and bounded IPv4/IPv6 networks',()=>{
 assert.equal(channelAllows(['*.corp.test'],new URL('https://x.corp.test')),true);
 assert.equal(channelAllows(['*.corp.test'],new URL('https://corp.test')),false);
 assert.equal(channelAllows(['corp.test'],new URL('https://corp.test.evil.test')),false);
 assert.equal(channelAllows(['10.20.0.0/16'],new URL('http://10.20.9.1')),true);
 assert.equal(channelAllows(['10.20.0.0/16'],new URL('http://10.21.9.1')),false);
 assert.equal(channelAllows(['fd00::/64'],new URL('http://[fd00::5]')),true);
});
