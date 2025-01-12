const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')
const validateMongoId = require('../middleware/validateMongoId')
const { uploadVideo } = require('../middleware/upload')

const {
  createLesson,
  getLessons,
  getLesson,
  updateLesson,
  deleteLesson,
  uploadLessonVideo,
  deleteLessonVideo,
  markLessonComplete,
  getLessonProgress,
  reorderLessons,
  getLessonQuiz,
  getVideoStreamUrl,
} = require('../controllers/lesson.controller')

const router = express.Router({ mergeParams: true })

// All routes are protected
router.use(protect)

// Public routes (for enrolled students)
router.get('/', validateMongoId, getLessons)
router.get('/:lessonId', validateMongoId, getLesson)
router.get('/:lessonId/video-url', validateMongoId, getVideoStreamUrl)
router.get('/:lessonId/quiz', validateMongoId, getLessonQuiz)
router.get('/:lessonId/progress', validateMongoId, getLessonProgress)
router.post('/:lessonId/complete', validateMongoId, markLessonComplete)

// Routes requiring course/module ownership
router.use(checkCourseOwnership)

// Lesson management routes
router.post('/', createLesson)
router.post('/reorder', reorderLessons)
router.put('/:lessonId', validateMongoId, updateLesson)
router.delete('/:lessonId', validateMongoId, deleteLesson)

// Video management routes
router.post('/:lessonId/video', validateMongoId, uploadVideo.single('video'), uploadLessonVideo)
router.delete('/:lessonId/video', validateMongoId, deleteLessonVideo)

module.exports = router
