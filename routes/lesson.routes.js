const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const validateMongoId = require('../middleware/validateMongoId')
const { uploadVideo, uploadAsset } = require('../middleware/upload')

const {
  createLesson,
  getLessons,
  getLesson,
  updateLesson,
  deleteLesson,
  uploadLessonVideo,
  getVideoStreamUrl,
  markLessonComplete,
  getLessonProgress,
  trackProgress,
  downloadAsset,
  updateAsset,
  deleteAsset,
} = require('../controllers/lesson.controller')

const parseFormDataJSON = require('../middleware/parseFormData')

const router = express.Router({ mergeParams: true })

// Basic lesson routes
router.get('/', protect, validateMongoId, getLessons)
router.get('/:lessonId', protect, validateMongoId, getLesson)

// Lesson creation/management (Admin/SubAdmin only)
router.post('/', protect, restrictTo('admin', 'subAdmin'), uploadAsset.array('assets', 10), parseFormDataJSON, createLesson)

router.put('/:lessonId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, uploadAsset.array('assets', 10), parseFormDataJSON, updateLesson)

router.delete('/:lessonId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, deleteLesson)

// Asset management routes
router.put('/:lessonId/assets/:assetId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, updateAsset)

router.delete('/:lessonId/assets/:assetId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, deleteAsset)

router.get('/:lessonId/assets/:assetId/download', protect, validateMongoId, downloadAsset)

// Video management routes
router.post('/:lessonId/video', protect, restrictTo('admin', 'subAdmin'), validateMongoId, uploadVideo.single('video'), uploadLessonVideo)

router.get('/:lessonId/video-url', protect, validateMongoId, getVideoStreamUrl)

// Progress tracking routes
router.post('/:lessonId/complete', protect, validateMongoId, markLessonComplete)

router.get('/:lessonId/progress', protect, validateMongoId, getLessonProgress)

router.post('/:lessonId/track-progress', protect, validateMongoId, trackProgress)

module.exports = router
