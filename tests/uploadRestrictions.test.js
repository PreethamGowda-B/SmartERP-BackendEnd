'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const multer = require('multer');
const { MAX_FILE_SIZE, handleMulterError } = require('../config/uploadLimits');
const { detectFileSignature, requireValidFileSignature } = require('../utils/fileValidation');

test('Centralized upload limit constant', () => {
  assert.equal(MAX_FILE_SIZE, 5 * 1024 * 1024, 'MAX_FILE_SIZE must equal exactly 5 MiB (5,242,880 bytes)');
});

test('handleMulterError middleware', async (t) => {
  await t.test('returns HTTP 413 on LIMIT_FILE_SIZE', () => {
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonBody = data;
        return this;
      }
    };
    const err = new Error('File too large');
    err.code = 'LIMIT_FILE_SIZE';

    handleMulterError(err, {}, res, () => assert.fail('Should not call next on error'));

    assert.equal(statusCode, 413);
    assert.equal(jsonBody.code, 'FILE_TOO_LARGE');
    assert.match(jsonBody.message, /5 MB/);
    assert.equal(jsonBody.maxSizeBytes, 5242880);
  });

  await t.test('returns HTTP 400 on LIMIT_FILE_COUNT', () => {
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonBody = data;
        return this;
      }
    };
    const err = new Error('Too many files');
    err.code = 'LIMIT_FILE_COUNT';

    handleMulterError(err, {}, res, () => assert.fail('Should not call next on error'));

    assert.equal(statusCode, 400);
    assert.equal(jsonBody.code, 'TOO_MANY_FILES');
  });

  await t.test('calls next when no error occurs', () => {
    let calledNext = false;
    handleMulterError(null, {}, {}, () => { calledNext = true; });
    assert.equal(calledNext, true);
  });
});

test('File-size test cases matrix', async (t) => {
  const testCases = [
    { name: '500 KB', bytes: 500 * 1024, expected: 'ACCEPT' },
    { name: '1 MB', bytes: 1 * 1024 * 1024, expected: 'ACCEPT' },
    { name: '3 MB', bytes: 3 * 1024 * 1024, expected: 'ACCEPT' },
    { name: 'Exactly 5 MiB', bytes: 5 * 1024 * 1024, expected: 'ACCEPT' },
    { name: '5 MiB + 1 byte', bytes: 5 * 1024 * 1024 + 1, expected: 'REJECT' },
    { name: '6 MB', bytes: 6 * 1024 * 1024, expected: 'REJECT' },
    { name: '10 MB', bytes: 10 * 1024 * 1024, expected: 'REJECT' },
    { name: '20 MB', bytes: 20 * 1024 * 1024, expected: 'REJECT' },
  ];

  for (const tc of testCases) {
    await t.test(`Size check: ${tc.name} (${tc.bytes} bytes) -> ${tc.expected}`, () => {
      const isAllowed = tc.bytes <= MAX_FILE_SIZE;
      if (tc.expected === 'ACCEPT') {
        assert.equal(isAllowed, true, `${tc.name} should be accepted`);
      } else {
        assert.equal(isAllowed, false, `${tc.name} should be rejected`);
      }
    });
  }
});

test('Base64 size verification (Proof of Work & AI flows)', async (t) => {
  // Simulates base64 upload size check: decoded buffer length must not exceed MAX_FILE_SIZE
  const sizes = [
    { name: '500 KB', bytes: 500 * 1024, shouldPass: true },
    { name: '1 MB', bytes: 1 * 1024 * 1024, shouldPass: true },
    { name: '3 MB', bytes: 3 * 1024 * 1024, shouldPass: true },
    { name: 'Exactly 5 MiB', bytes: 5 * 1024 * 1024, shouldPass: true },
    { name: '5 MiB + 1 byte', bytes: 5 * 1024 * 1024 + 1, shouldPass: false },
    { name: '6 MB', bytes: 6 * 1024 * 1024, shouldPass: false },
    { name: '10 MB', bytes: 10 * 1024 * 1024, shouldPass: false },
    { name: '20 MB', bytes: 20 * 1024 * 1024, shouldPass: false },
  ];

  for (const s of sizes) {
    await t.test(`Base64 binary check: ${s.name}`, () => {
      const buffer = Buffer.alloc(s.bytes);
      const isWithinLimit = buffer.length <= MAX_FILE_SIZE;
      assert.equal(isWithinLimit, s.shouldPass);
    });
  }
});

test('Multer memory storage enforcement', async (t) => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE }
  });

  // Verify that the multer instance has the 5 MB limit configured
  assert.equal(upload.limits.fileSize, 5 * 1024 * 1024);
});

test('Security tests: File type & Magic Byte signature validation', async (t) => {
  await t.test('Valid JPEG signature is detected', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const detected = detectFileSignature(jpegBuffer);
    assert.ok(detected);
    assert.equal(detected.mime, 'image/jpeg');
  });

  await t.test('Valid PNG signature is detected', () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const detected = detectFileSignature(pngBuffer);
    assert.ok(detected);
    assert.equal(detected.mime, 'image/png');
  });

  await t.test('Valid PDF signature is detected', () => {
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const detected = detectFileSignature(pdfBuffer);
    assert.ok(detected);
    assert.equal(detected.mime, 'application/pdf');
  });

  await t.test('Forged executable renamed as image is rejected', () => {
    // Windows PE / MZ executable signature: 'MZ' (0x4D, 0x5A)
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const detected = detectFileSignature(exeBuffer);
    assert.equal(detected, null);

    const middleware = requireValidFileSignature({
      allowedMimes: ['image/jpeg', 'image/png'],
      fieldName: 'file'
    });

    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonBody = data;
        return this;
      }
    };
    const req = {
      file: {
        buffer: exeBuffer,
        originalname: 'innocent_photo.jpg',
        mimetype: 'image/jpeg'
      }
    };

    middleware(req, res, () => assert.fail('Should not allow forged executable'));
    assert.equal(statusCode, 400);
    assert.match(jsonBody.message, /binary signature does not match/);
  });
});
