// error.js
const { AppError } = require('../utils/errors')
const mongoose = require('mongoose')

const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}`
  return new AppError(message, 400)
}

const handleDuplicateFieldsDB = (err) => {
  const field = Object.keys(err.keyPattern)[0]
  const value = err.keyValue[field]

  let message
  switch (field) {
    case 'email':
      message = 'This email is already registered'
      break
    default:
      message = `${field} '${value}' is already in use`
  }

  return new AppError(message, 400)
}

const handleValidationErrorDB = (err) => {
  const messages = Object.values(err.errors)
    .map((error) => error.message)
    .join(', ')

  return new AppError(messages, 400)
}

const handleJWTError = () => new AppError('Your session is invalid. Please log in again.', 401)

const handleJWTExpiredError = () => new AppError('Your session has expired. Please log in again.', 401)

const handleMongooseError = (err) => {
  if (err instanceof mongoose.Error.ValidationError) {
    return handleValidationErrorDB(err)
  }

  if (err.code === 11000) {
    return handleDuplicateFieldsDB(err)
  }

  if (err instanceof mongoose.Error.CastError) {
    return handleCastErrorDB(err)
  }

  return new AppError(err.message, 400)
}

module.exports = (err, req, res, next) => {
  let error = err instanceof AppError ? err : handleMongooseError(err)

  // Handle JWT Errors
  if (err.name === 'JsonWebTokenError') error = handleJWTError()
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError()

  // Build response object
  const responseBody = {
    status: error.status || 'error',
    message: error.message,
  }

  // Add debug info in development
  if (process.env.NODE_ENV === 'development') {
    responseBody.stack = error.stack
  }

  // Send response
  res.status(error.statusCode || 500).json(responseBody)
}

// const { AppError } = require('../utils/errors')
// const mongoose = require('mongoose')

// const handleCastErrorDB = (err) => {
//   const message = `Invalid ${err.path}: ${err.value}`
//   return new AppError(message, 400)
// }

// const handleDuplicateFieldsDB = (err) => {
//   const field = Object.keys(err.keyPattern)[0]
//   const value = err.keyValue[field]

//   let message
//   switch (field) {
//     case 'email':
//       message = 'This email is already registered'
//       break
//     default:
//       message = `${field} '${value}' is already in use`
//   }

//   return new AppError(message, 400)
// }

// const handleValidationErrorDB = (err) => {
//   const errors = []

//   Object.values(err.errors).forEach((error) => {
//     if (error.name === 'ValidatorError') {
//       errors.push({
//         field: error.path,
//         message: error.message,
//       })
//     }
//   })

//   const appError = new AppError('Validation failed', 400)
//   appError.errors = errors
//   return appError
// }

// const handleJWTError = () => new AppError('Your session is invalid. Please log in again.', 401)

// const handleJWTExpiredError = () => new AppError('Your session has expired. Please log in again.', 401)

// const handleMongooseError = (err) => {
//   if (err instanceof mongoose.Error.ValidationError) {
//     return handleValidationErrorDB(err)
//   }

//   if (err.code === 11000) {
//     return handleDuplicateFieldsDB(err)
//   }

//   if (err instanceof mongoose.Error.CastError) {
//     return handleCastErrorDB(err)
//   }

//   return new AppError(err.message, 400) // Convert unknown errors to AppError
// }

// module.exports = (err, req, res, next) => {
//   // Convert any non-AppError to AppError
//   let error = err instanceof AppError ? err : handleMongooseError(err)

//   // Handle JWT Errors
//   if (err.name === 'JsonWebTokenError') error = handleJWTError()
//   if (err.name === 'TokenExpiredError') error = handleJWTExpiredError()

//   // Build response object
//   const responseBody = {
//     status: error.status || 'error',
//     message: error.message, // This should now properly show up
//   }

//   // Add validation errors if they exist
//   if (error.errors) {
//     responseBody.errors = error.errors
//   }

//   // Add debug info in development
//   if (process.env.NODE_ENV === 'development') {
//     responseBody.stack = error.stack
//   }

//   // Send response
//   res.status(error.statusCode || 500).json(responseBody)
// }
