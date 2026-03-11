const crypto = require('node:crypto');

const ARGON2_PARAMS = {
  algorithm: 'argon2id',
  memory: 64 * 1024,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
};

function hashPassword(password) {
  const nonce = crypto.randomBytes(16);
  const hash = crypto.argon2Sync(ARGON2_PARAMS.algorithm, {
    message: Buffer.from(password, 'utf8'),
    nonce,
    memory: ARGON2_PARAMS.memory,
    passes: ARGON2_PARAMS.passes,
    parallelism: ARGON2_PARAMS.parallelism,
    tagLength: ARGON2_PARAMS.tagLength,
  });

  return [
    ARGON2_PARAMS.algorithm,
    `m=${ARGON2_PARAMS.memory},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}`,
    nonce.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

function verifyPassword(password, encoded) {
  if (!encoded || typeof encoded !== 'string') return false;

  const [algorithm, params, noncePart, hashPart] = encoded.split('$');
  if (!algorithm || !params || !noncePart || !hashPart) return false;

  const values = Object.fromEntries(
    params.split(',').map((entry) => {
      const [key, value] = entry.split('=');
      return [key, Number(value)];
    })
  );

  const nonce = Buffer.from(noncePart, 'base64url');
  const expected = Buffer.from(hashPart, 'base64url');
  const actual = crypto.argon2Sync(algorithm, {
    message: Buffer.from(password, 'utf8'),
    nonce,
    memory: values.m,
    passes: values.t,
    parallelism: values.p,
    tagLength: expected.length,
  });

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
