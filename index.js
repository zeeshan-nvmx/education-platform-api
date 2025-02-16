require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const mongoSanitize = require('express-mongo-sanitize')
const xss = require('xss-clean')
const hpp = require('hpp')
const { apiLimiter } = require('./middleware/rateLimiter')
const errorHandler = require('./middleware/error')
const { AppError } = require('./utils/errors')
const testEnrollmentRouter = require('./routes/testEnrollment.routes')
const winston = require('winston')

const app = express()
let server

// Winston Logger Setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.splat(),
    winston.format.json() // Keep logs clean for Railway
  ),
  transports: [new winston.transports.Console()],
})


// Function to Sanitize Sensitive Data
const sanitizeData = (data) => {
  if (!data) return data
  const sanitized = { ...data }
  if (sanitized.password) sanitized.password = '[FILTERED]'
  if (sanitized.token) sanitized.token = '[FILTERED]'
  if (sanitized.email) sanitized.email = '[FILTERED]'
  return sanitized
}

// Global Middleware
app.use(cors())
app.use(helmet())
app.use(express.json({ limit: '10kb' }))
app.use(express.urlencoded({ extended: true, limit: '10kb' }))
app.use(mongoSanitize())
app.use(xss())
app.use(hpp())
app.use(compression())
app.set('trust proxy', 1)
app.use('/api', apiLimiter)

// Verbose Request Logging with Sensitive Data Filtering
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    logger.info('HTTP Request', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      responseTime: `${duration}ms`,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      origin: req.headers.origin || 'N/A',
      referer: req.headers.referer || 'N/A',
      userAgent: req.headers['user-agent'] || 'N/A',
      headers: sanitizeData(req.headers),
      query: sanitizeData(req.query),
      body: sanitizeData(req.body),
    })
  })
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
app.use('/api/payments', require('./routes/payment.routes'))
app.use('/api/test-enrollment', testEnrollmentRouter)

// 404 Handler
app.all('*', (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404))
})

// Global Error Handler with Verbose Logging and Data Filtering
app.use((err, req, res, next) => {
  logger.error('Unhandled Error', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    headers: sanitizeData(req.headers),
    query: sanitizeData(req.query),
    body: sanitizeData(req.body),
  })
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal Server Error' })
})

// Handle Uncaught Exceptions
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', { message: err.message, stack: err.stack })
  process.exit(1)
})

// Handle Unhandled Rejections
process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...', { message: err.message, stack: err.stack })
  if (server) {
    server.close(() => process.exit(1))
  } else {
    process.exit(1)
  }
})

const port = process.env.PORT || 3000

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    logger.info('MongoDB connected')
    server = app.listen(port, () => {
      logger.info(`🚀 Server running on port ${port}`)
    })
  })
  .catch((err) => {
    logger.error('MongoDB connection error', { message: err.message, stack: err.stack })
    process.exit(1)
  })
