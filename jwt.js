const fs = require('fs');
const jwt = require('jsonwebtoken');

function jwtGenerator(opts) {
  return function() {
    const pem = fs.readFileSync(opts.keyFile);

    const token = jwt.sign({}, pem, {
      algorithm: 'RS256',
      expiresIn: 5 * 60,
      issuer: `${opts.issuer}`,
    });

    pem.fill(0);

    return token;
  };
}

module.exports = jwtGenerator;
