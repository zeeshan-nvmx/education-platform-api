require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const compression = require('compression')
const mongoSanitize = require('express-mongo-sanitize')
const xss = require('xss-clean')
const hpp = require('hpp')
const { apiLimiter } = require('./middleware/rateLimiter')
const errorHandler = require('./middleware/error')
const { AppError } = require('./utils/errors')

const app = express()
let server

// Global Middleware
app.use(cors())
app.use(helmet())
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'))
}
app.use(express.json({ limit: '10kb' }))
app.use(express.urlencoded({ extended: true, limit: '10kb' }))
app.use(mongoSanitize())
app.use(xss())
app.use(hpp())
app.use(compression())
app.use('/api', apiLimiter)

// Request Logger for Debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`)
  next()
})

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

// Routes
app.use('/api/auth', require('./routes/auth.routes'))
app.use('/api/users', require('./routes/user.routes'))
app.use('/api/admin', require('./routes/admin.routes'))
app.use('/api/courses', require('./routes/course.routes'))
// app.use('/api/modules', require('./routes/modules'));
// app.use('/api/lessons', require('./routes/lessons'));
// app.use('/api/quizzes', require('./routes/quizzes'));
// app.use('/api/payments', require('./routes/payments'));
// app.use('/api/discounts', require('./routes/discounts'));
// app.use('/api/progress', require('./routes/progress'));
// app.use('/api/reviews', require('./routes/reviews'));

// 404 Handler
app.all('*', (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404))
})

// Global Error Handler
app.use(errorHandler)

// Handle Uncaught Exceptions
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...')
  console.error(err.name, err.message)
  process.exit(1)
})

// Handle Unhandled Rejections
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...')
  console.error(err.name, err.message)
  if (server) {
    server.close(() => {
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
})

const port = process.env.PORT || 3000

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected')
    server = app.listen(port, () => {
      console.log(`Server running on port ${port}`)
    })
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err)
    process.exit(1)
  })

// require('dotenv').config()
// const express = require('express')
// const mongoose = require('mongoose')
// const cors = require('cors')
// const helmet = require('helmet')
// const morgan = require('morgan')
// const compression = require('compression')
// const mongoSanitize = require('express-mongo-sanitize')
// const xss = require('xss-clean')
// const hpp = require('hpp')
// const { apiLimiter } = require('./middleware/rateLimiter')
// const errorHandler = require('./middleware/error')

// const app = express()
// let server

// // Global Middleware
// app.use(cors())
// app.use(helmet())
// if (process.env.NODE_ENV === 'development') {
//   app.use(morgan('dev'))
// }
// app.use(express.json({ limit: '10kb' }))
// app.use(express.urlencoded({ extended: true, limit: '10kb' }))
// app.use(mongoSanitize())
// app.use(xss())
// app.use(hpp())
// app.use(compression())
// app.use('/api', apiLimiter)

// // Request Logger for Debugging
// app.use((req, res, next) => {
//   console.log(`${req.method} ${req.originalUrl}`)
//   next()
// })

// // Health Check
// app.get('/health', (req, res) => {
//   res.status(200).json({ status: 'ok' })
// })

// // Routes
// app.use('/api/auth', require('./routes/auth.routes'))
// app.use('/api/users', require('./routes/user.routes'));
// app.use('/api/admin', require('./routes/admin.routes'));
// app.use('/api/courses', require('./routes/course.routes'));
// // app.use('/api/modules', require('./routes/modules'));
// // app.use('/api/lessons', require('./routes/lessons'));
// // app.use('/api/quizzes', require('./routes/quizzes'));
// // app.use('/api/payments', require('./routes/payments'));
// // app.use('/api/discounts', require('./routes/discounts'));
// // app.use('/api/progress', require('./routes/progress'));
// // app.use('/api/reviews', require('./routes/reviews'));

// // 404 Handler
// app.all('*', (req, res) => {
//   res.status(404).json({
//     status: 'error',
//     message: `Can't find ${req.originalUrl} on this server!`,
//   })
// })

// // Global Error Handler
// app.use(errorHandler)

// // Base Error Handler
// app.use((err, req, res, next) => {
//   console.error(err.stack)
//   res.status(500).json({
//     status: 'error',
//     message: err.message || 'Internal server error',
//   })
// })

// // Handle Uncaught Exceptions
// process.on('uncaughtException', (err) => {
//   console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...')
//   console.error(err.name, err.message)
//   process.exit(1)
// })

// // Handle Unhandled Rejections
// process.on('unhandledRejection', (err) => {
//   console.error('UNHANDLED REJECTION! 💥 Shutting down...')
//   console.error(err.name, err.message)
//   if (server) {
//     server.close(() => {
//       process.exit(1)
//     })
//   } else {
//     process.exit(1)
//   }
// })

// const port = process.env.PORT || 3000

// // Connect to MongoDB
// mongoose
//   .connect(process.env.MONGODB_URI)
//   .then(() => {
//     console.log('MongoDB connected')
//     server = app.listen(port, () => {
//       console.log(`Server running on port ${port}`)
//     })
//   })
//   .catch((err) => console.error('MongoDB connection error:', err))
