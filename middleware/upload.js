const multer = require('multer')
const { AppError } = require('../utils/errors')

const storage = multer.memoryStorage()

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true)
  } else {
    cb(new AppError('Not a video file! Please upload only videos.', 400), false)
  }
}

exports.uploadVideo = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
})
