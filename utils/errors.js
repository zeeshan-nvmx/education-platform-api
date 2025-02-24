// errors.js
class AppError extends Error {
  constructor(message, statusCode) {
    // If message is a Joi error object, format it
    if (message && message.details) {
      message = message.details.map((detail) => detail.message.replace(/"/g, '')).join(', ')
    }

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

// // errors.js
// class AppError extends Error {
//   constructor(message, statusCode) {
//     super(message)
//     this.statusCode = statusCode
//     this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error'
//     this.isOperational = true

//     Object.defineProperty(this, 'message', {
//       value: message,
//       enumerable: true,
//     })

//     if (process.env.NODE_ENV === 'production') {
//       this.stack = undefined
//     } else {
//       Error.captureStackTrace(this, this.constructor)
//     }
//   }
// }

// module.exports = {
//   AppError,
// }
