const crypto = require('crypto')

exports.generateRandomToken = () => {
  return crypto.randomBytes(32).toString('hex')
}
