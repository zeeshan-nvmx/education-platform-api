const rateLimit = require('express-rate-limit')

exports.loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts, please try again after 15 minutes',
})

exports.apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
})

