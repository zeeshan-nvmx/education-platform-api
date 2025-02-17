// errors.js
class AppError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.statusCode = statusCode
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error'
    this.isOperational = true

    Object.defineProperty(this, 'message', {
      value: message,
      enumerable: true, 
    })

    if (process.env.NODE_ENV === 'production') {
      this.stack = undefined
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

module.exports = {
  AppError,
}

// class AppError extends Error {
//   constructor(message, statusCode) {
//     super(message)
//     this.statusCode = statusCode
//     this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error'
//     this.isOperational = true
//     Error.captureStackTrace(this, this.constructor)
//   }
// }

// exports.AppError = AppError
