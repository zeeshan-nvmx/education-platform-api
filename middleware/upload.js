// const multer = require('multer')
// const { AppError } = require('../utils/errors')

// const storage = multer.memoryStorage()

// const fileFilter = (req, file, cb) => {
//   if (file.mimetype.startsWith('video/')) {
//     cb(null, true)
//   } else {
//     cb(new AppError('Not a video file! Please upload only videos.', 400), false)
//   }
// }

// exports.uploadVideo = multer({
//   storage,
//   fileFilter,
//   limits: {
//     fileSize: 100 * 1024 * 1024, // 100MB limit
//   },
// })


const multer = require('multer')
const { AppError } = require('../utils/errors')

const storage = multer.memoryStorage()

// Original video file filter - keeping exactly as is
const videoFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true)
  } else {
    cb(new AppError('Not a video file! Please upload only videos.', 400), false)
  }
}

// New asset file filter
const assetFileFilter = (req, file, cb) => {
  const allowedMimes = [
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Archives
    'application/zip',
    'application/x-rar-compressed',
    // Text
    'text/plain',
    'text/markdown',
    // Images
    'image/jpeg',
    'image/png',
    'image/gif',
    // Code files
    'text/javascript',
    'application/json',
    'text/html',
    'text/css',
    'text/x-python',
    'text/x-java',
  ]

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new AppError('Invalid file type! Please upload only allowed file types.', 400), false)
  }
}

// Original video upload configuration - keeping exactly as is
exports.uploadVideo = multer({
  storage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
})

// New asset upload configuration
exports.uploadAsset = multer({
  storage,
  fileFilter: assetFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for assets
  },
})

// Quiz attachment configuration
exports.uploadQuizAttachment = multer({
  storage,
  fileFilter: assetFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for quiz attachments
  },
})

// Error handler for multer
exports.handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('File too large! Please upload a smaller file.', 400))
    }
    return next(new AppError(err.message, 400))
  }
  next(err)
}