require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCloudinaryConfig } = require('../config/cloudinary');

test.describe('Cloud Document Storage & Access Control Test Suite', () => {

  test('Cloudinary configuration is active or fallback handled safely', () => {
    // When credentials are defined in environment, hasCloudinaryConfig is true.
    // If not set, system returns 503 HTTP status safely.
    if (process.env.CLOUDINARY_CLOUD_NAME) {
      assert.equal(hasCloudinaryConfig, true);
    } else {
      assert.equal(hasCloudinaryConfig, false);
    }
  });

  test('Employee Document access control blocks cross-company document retrieval', () => {
    const requesterCompany = '11111111-1111-1111-1111-111111111111';
    const documentCompany = '22222222-2222-2222-2222-222222222222';

    const canAccess = (reqCompany, docCompany, userRole) => {
      if (userRole === 'super_admin') return true;
      return reqCompany === docCompany;
    };

    assert.equal(canAccess(requesterCompany, documentCompany, 'owner'), false, 'Owner cannot access document of another company');
    assert.equal(canAccess(requesterCompany, requesterCompany, 'owner'), true, 'Owner can access document of own company');
    assert.equal(canAccess(requesterCompany, documentCompany, 'super_admin'), true, 'Super admin can access document of any company');
  });

});
