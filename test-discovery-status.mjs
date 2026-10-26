import assert from 'node:assert/strict';
import {discoveryOutcome} from './discovery-status.mjs';
for (const [blockers,findings] of [[[],[]],[[],[{title:'candidate'}]],[[{reason:'timeout'}],[]],[[{reason:'timeout'}],[{}]]]) {
  const result=discoveryOutcome(blockers,findings);
  assert.equal(result.outcome,'partial');
  assert.notEqual(result.status,'completed');
  assert.equal(result.publicationComplete,false);
}
console.log('Discovery cannot claim full completion: passed');
