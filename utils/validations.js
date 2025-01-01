const Joi = require('joi')

exports.validateEmail = (email) => {
  const schema = Joi.string().email().required()
  return schema.validate(email)
}

exports.validatePassword = (password) => {
  const schema = Joi.string().min(8).required()
  return schema.validate(password)
}

// utils/errors.js
class AppError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.statusCode = statusCode
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error'
    this.isOperational = true
    Error.captureStackTrace(this, this.constructor)
  }
}

exports.AppError = AppError
