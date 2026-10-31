import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../config.mjs';
import { createChecker } from '../checker.mjs';
import { fixture } from './fixture.mjs';

const browserRunner = async () => ({ fixtureOnly: true });
async function authority(f, input = {}) {
  const report = await createChecker(configuration({ ...f.config, ...input }), { browserRunner })();
  return report.checks.find(check => check.name === 'authority-alternative');
}
test('alternate authority uses an observed routable ACA Host, not an invented unrouted Host', async () => {
  const f = await fixture({ acaRouting: true });
  try {
    assert.equal((await authority(f)).status, 'PASS');
    assert.deepEqual(f.state.alternativeRequests, [{ host: new URL(f.config.acaUrls[0]).host, forwardedHost: new URL(f.api).host }]);
  } finally { await f.close(); }
});
test('missing distinct observed ACA authority is INCOMPLETE and sends no invented Host', async () => {
  const f = await fixture({ acaRouting: true });
  try {
    for (const acaUrls of [[], [f.api]]) {
      const row = await authority(f, { acaUrls });
      assert.equal(row.status, 'INCOMPLETE');
      assert.equal(row.errorClass, 'configuration/alternative-authority-target');
      assert.equal(row.httpStatus, null);
    }
    assert.equal(f.state.alternativeRequests, undefined);
  } finally { await f.close(); }
});
test('routable alternative still requires exact 400 without a redirect; explicit unrouted authority fails', async () => {
  const f = await fixture({ acaRouting: true });
  try {
    for (const status of [200, 302, 404]) {
      f.state.alternativeStatus = status;
      const row = await authority(f);
      assert.equal(row.status, 'FAIL'); assert.equal(row.httpStatus, status);
      assert.equal(row.errorClass, 'transport/alternative-authority');
    }
    f.state.alternativeStatus = 400; f.state.alternativeLocation = f.api;
    assert.equal((await authority(f)).status, 'FAIL');
    const explicit = await authority(f, { alternativeAuthority: 'invalid.example' });
    assert.equal(explicit.status, 'FAIL'); assert.equal(explicit.httpStatus, 404);
  } finally { await f.close(); }
});
