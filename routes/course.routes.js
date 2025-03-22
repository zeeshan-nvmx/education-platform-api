const express = require('express')
const multer = require('multer')
const { protect, restrictTo, optionalAuth } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')
const validateMongoId = require('../middleware/validateMongoId')
const { uploadVideo } = require('../middleware/upload')

// Import module router
const moduleRouter = require('./module.routes')
const lessonRouter = require('./lesson.routes')
// const moduleReviewRouter = require('./moduleReview.routes')

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Not an image! Please upload only images.'), false)
    }
  },
})

// Create middleware to handle multiple file uploads
const uploadFields = upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'instructorImages', maxCount: 10 },
])

// Create middleware for single instructor image upload
const uploadInstructorImage = upload.fields([{ name: 'instructorImage', maxCount: 1 }])

// Create middleware for knowledge part images
const uploadKnowledgeImagesMiddleware = upload.fields([
  { name: 'knowledgePartImage1', maxCount: 1 },
  { name: 'knowledgePartImage2', maxCount: 1 },
])

const {
  createCourse,
  getAllCourses,
  getCourse,
  updateCourse,
  uploadCourseTrailer,
  deleteCourse,
  getFeaturedCourses,
  getCoursesByCategory,
  getCourseModules,
  checkModuleAccess,
  getCourseProgress,
  getModuleProgress,
  getPublicCoursesList,
  updateInstructor,
  deleteInstructor,
  // New controller functions
  updateCourseDetails,
  uploadKnowledgeImages,
  deleteKnowledgeImage,
} = require('../controllers/course.controller')

const router = express.Router()

// Public routes with optional authentication
router.get('/featured', optionalAuth, getFeaturedCourses)
router.get('/public', optionalAuth, getPublicCoursesList)
router.get('/category/:category', optionalAuth, getCoursesByCategory)
router.get('/', optionalAuth, getAllCourses)
router.get('/:courseId', optionalAuth, getCourse)

// Protected routes - require authentication
router.get('/:courseId/progress', protect, validateMongoId, getCourseProgress)
router.get('/:courseId/modules/:moduleId/progress', protect, validateMongoId, getModuleProgress)
router.get('/:courseId/modules/:moduleId/access', protect, validateMongoId, checkModuleAccess)

// Admin/SubAdmin routes
router.post('/', protect, restrictTo('admin', 'subAdmin'), uploadFields, createCourse)
router.put('/:courseId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, /* checkCourseOwnership, */ uploadFields, updateCourse)
router.delete('/:courseId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, /* checkCourseOwnership, */ deleteCourse)

// Instructor routes
router.patch('/:courseId/instructors', protect, restrictTo('admin', 'subAdmin'), validateMongoId, uploadInstructorImage, updateInstructor)
router.delete('/:courseId/instructors', protect, restrictTo('admin', 'subAdmin'), validateMongoId, deleteInstructor)

// Trailer upload route
router.post('/:courseId/trailer', protect, restrictTo('admin', 'subAdmin'), validateMongoId, uploadVideo.single('video'), uploadCourseTrailer)

// New routes for course additional details
router.put('/:courseId/details', protect, restrictTo('admin', 'subAdmin'), validateMongoId, updateCourseDetails)
router.post('/:courseId/knowledge-images', protect, restrictTo('admin', 'subAdmin'), validateMongoId, uploadKnowledgeImagesMiddleware, uploadKnowledgeImages)
router.delete('/:courseId/knowledge-images/:part', protect, restrictTo('admin', 'subAdmin'), validateMongoId, deleteKnowledgeImage)

// Module-related routes
router.get('/:courseId/modules', validateMongoId, getCourseModules)

// Mount module router - this will handle module routes including review routes
router.use('/:courseId/modules', moduleRouter)

// Forward lesson routes
router.use('/:courseId/modules/:moduleId/lessons', lessonRouter)

module.exports = router

// const express = require('express')
// const multer = require('multer')
// const { protect, restrictTo, optionalAuth } = require('../middleware/auth')
// const { checkCourseOwnership } = require('../middleware/checkOwnership')
// const validateMongoId = require('../middleware/validateMongoId')
// const { uploadVideo } = require('../middleware/upload')

// // Import module router
// const moduleRouter = require('./module.routes')
// const lessonRouter = require('./lesson.routes')
// // const moduleReviewRouter = require('./moduleReview.routes')

// // Configure multer for memory storage
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: {
//     fileSize: 5 * 1024 * 1024, // 5MB limit
//   },
//   fileFilter: (req, file, cb) => {
//     if (file.mimetype.startsWith('image/')) {
//       cb(null, true)
//     } else {
//       cb(new Error('Not an image! Please upload only images.'), false)
//     }
//   },
// })

// // Create middleware to handle multiple file uploads
// const uploadFields = upload.fields([
//   { name: 'thumbnail', maxCount: 1 },
//   { name: 'instructorImages', maxCount: 10 },
// ])

// const {
//   createCourse,
//   getAllCourses,
//   getCourse,
//   updateCourse,
//   uploadCourseTrailer,
//   deleteCourse,
//   getFeaturedCourses,
//   getCoursesByCategory,
//   getCourseModules,
//   checkModuleAccess,
//   getCourseProgress,
//   getModuleProgress,
//   getPublicCoursesList,
// } = require('../controllers/course.controller')

// const router = express.Router()

// // Public routes with optional authentication
// router.get('/featured', optionalAuth, getFeaturedCourses)
// router.get('/public', optionalAuth, getPublicCoursesList)
// router.get('/category/:category', optionalAuth, getCoursesByCategory)
// router.get('/', optionalAuth, getAllCourses)
// router.get('/:courseId', optionalAuth, getCourse)

// // Protected routes - require authentication
// router.get('/:courseId/progress', protect, validateMongoId, getCourseProgress)
// router.get('/:courseId/modules/:moduleId/progress', protect, validateMongoId, getModuleProgress)
// router.get('/:courseId/modules/:moduleId/access', protect, validateMongoId, checkModuleAccess)

// // Admin/SubAdmin routes
// router.post('/', protect, restrictTo('admin', 'subAdmin'), uploadFields, createCourse)
// router.put('/:courseId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, /* checkCourseOwnership, */ uploadFields, updateCourse)
// router.delete('/:courseId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, /* checkCourseOwnership, */ deleteCourse)

// // trailer upload route
// router.post('/:courseId/trailer', protect, restrictTo('admin', 'subAdmin'), validateMongoId, uploadVideo.single('video'), uploadCourseTrailer)

// // Module-related routes
// router.get('/:courseId/modules', validateMongoId, getCourseModules)

// // Mount module router - this will handle module routes including review routes
// router.use('/:courseId/modules', moduleRouter)

// // Forward lesson routes
// router.use('/:courseId/modules/:moduleId/lessons', lessonRouter)

// module.exports = router
