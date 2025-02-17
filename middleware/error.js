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
  const errors = []

  Object.values(err.errors).forEach((error) => {
    if (error.name === 'ValidatorError') {
      errors.push({
        field: error.path,
        message: error.message,
      })
    }
  })

  // Return AppError instance with additional errors array
  const appError = new AppError('Validation failed', 400)
  appError.errors = errors
  return appError
}

const handleJWTError = () => new AppError('Your session is invalid. Please log in again.', 401)

const handleJWTExpiredError = () => new AppError('Your session has expired. Please log in again.', 401)

// Handle Mongoose Errors
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

  return err
}

module.exports = (err, req, res, next) => {
  console.log('Original Error:', err)

  let error = err
  // Only spread if it's not already an AppError
  if (!(err instanceof AppError)) {
    error = handleMongooseError({ ...err, message: err.message })
  }

  // Handle JWT Errors
  if (err.name === 'JsonWebTokenError') error = handleJWTError()
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError()

  const statusCode = error.statusCode || 500
  const status = error.status || 'error'

  // Prepare the response object
  const errorResponse = {
    status,
    message: error.message,
  }

  // Add errors array if it exists
  if (error.errors) {
    errorResponse.errors = error.errors
  }

  // Add additional details in development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error = error
    errorResponse.stack = error.stack
  }

  // Final Response
  if (process.env.NODE_ENV === 'development') {
    res.status(statusCode).json(errorResponse)
  } else {
    // Production Error Response
    if (error.isOperational || status === 'fail') {
      // For operational errors, send the error message
      delete errorResponse.error
      delete errorResponse.stack
      res.status(statusCode).json(errorResponse)
    } else {
      // For programming or unknown errors
      console.error('ERROR 💥:', error)
      res.status(500).json({
        status: 'error',
        message: 'Something went wrong!',
      })
    }
  }
}

// const { AppError } = require('../utils/errors')
// const mongoose = require('mongoose')

// const handleCastErrorDB = (err) => {
//   const message = `Invalid ${err.path}: ${err.value}`
//   return new AppError(message, 400)
// }

// const handleDuplicateFieldsDB = (err) => {
//   // Extract field name from the error
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

//   return {
//     statusCode: 400,
//     status: 'fail',
//     message: 'Validation failed',
//     errors,
//   }
// }

// const handleJWTError = () => new AppError('Your session is invalid. Please log in again.', 401)

// const handleJWTExpiredError = () => new AppError('Your session has expired. Please log in again.', 401)

// // Handle Mongoose Errors
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

//   return err
// }

// module.exports = (err, req, res, next) => {
//   err.statusCode = err.statusCode || 500
//   err.status = err.status || 'error'

//   let error = { ...err }
//   error.message = err.message
//   error = handleMongooseError(error)

//   // Handle JWT Errors
//   if (err.name === 'JsonWebTokenError') error = handleJWTError()
//   if (err.name === 'TokenExpiredError') error = handleJWTExpiredError()

//   // Final Response
//   if (process.env.NODE_ENV === 'development') {
//     // Development Error Response
//     res.status(error.statusCode || 500).json({
//       status: error.status,
//       message: error.message,
//       errors: error.errors || undefined,
//       error: error,
//       stack: error.stack,
//     })
//   } else {
//     // Production Error Response
//     if (error.isOperational || error.status === 'fail') {
//       res.status(error.statusCode).json({
//         status: error.status,
//         message: error.message,
//         errors: error.errors || undefined,
//       })
//     } else {
//       // Programming or unknown errors
//       console.error('ERROR 💥:', error)
//       res.status(500).json({
//         status: 'error',
//         message: 'Something went wrong!',
//       })
//     }
//   }
// }
