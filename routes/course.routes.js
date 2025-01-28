const express = require('express')
const multer = require('multer')
const { protect, restrictTo } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')
const validateMongoId = require('../middleware/validateMongoId')

// Import module router
const moduleRouter = require('./module.routes')
const lessonRouter = require('./lesson.routes')

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

const {
  createCourse,
  getAllCourses,
  getCourse,
  updateCourse,
  deleteCourse,
  getFeaturedCourses,
  getCoursesByCategory,
  getCourseModules,
  checkModuleAccess,
  getCourseProgress,
  getModuleProgress,
  enrollInCourse,
  enrollInModule,
  getEnrollmentStatus,
} = require('../controllers/course.controller')

const router = express.Router()

// Public routes
router.get('/featured', getFeaturedCourses)

router.get('/category/:category', getCoursesByCategory)

router.get('/', getAllCourses)

router.get('/:courseId', validateMongoId, getCourse)

// Protected routes - require authentication
router.get('/:courseId/progress', protect, validateMongoId, getCourseProgress)

router.get('/:courseId/modules/:moduleId/progress', protect, validateMongoId, getModuleProgress)

router.get('/:courseId/modules/:moduleId/access', protect, validateMongoId, checkModuleAccess)

// Admin/SubAdmin routes
router.post('/', protect, restrictTo('admin', 'subAdmin'), uploadFields, createCourse)

// Routes requiring course ownership
router.put('/:courseId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, checkCourseOwnership, uploadFields, updateCourse)

router.delete('/:courseId', protect, restrictTo('admin', 'subAdmin'), validateMongoId, checkCourseOwnership, deleteCourse)

// Module-related routes
router.get('/:courseId/modules', validateMongoId, getCourseModules)

// Forward module routes
router.use('/:courseId/modules', moduleRouter)

// Forward lesson routes
router.use('/:courseId/modules/:moduleId/lessons', lessonRouter)

module.exports = router

// const express = require('express')
// const multer = require('multer')
// const { protect, restrictTo } = require('../middleware/auth')
// const { checkCourseOwnership } = require('../middleware/checkOwnership')
// const validateMongoId = require('../middleware/validateMongoId')

// // Import module router
// const moduleRouter = require('./module.routes')
// const lessonRouter = require('./lesson.routes')

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
//   deleteCourse,
//   getFeaturedCourses,
//   getCoursesByCategory,
//   getCourseModules,
//   checkModuleAccess,
//   getCourseProgress,
//   getModuleProgress,
//   enrollInCourse,
//   enrollInModule,
//   getEnrollmentStatus,
// } = require('../controllers/course.controller')

// const router = express.Router()

// // Public routes
// router.get('/featured', getFeaturedCourses)
// router.get('/category/:category', getCoursesByCategory)
// router.get('/', getAllCourses)
// router.get('/:courseId', validateMongoId, getCourse)

// // Protected routes
// router.use(protect)

// // Course progress routes
// router.get('/:courseId/progress', validateMongoId, getCourseProgress)
// router.get('/:courseId/modules/:moduleId/progress', validateMongoId, getModuleProgress)
// router.get('/:courseId/modules/:moduleId/access', validateMongoId, checkModuleAccess)

// // Course management routes (admin/subAdmin only)
// router.use(restrictTo('admin', 'subAdmin'))
// router.route('/').post(uploadFields, createCourse)

// // Routes requiring course ownership
// router.use('/:courseId', validateMongoId, checkCourseOwnership)
// router.route('/:courseId').put(uploadFields, updateCourse).delete(deleteCourse)

// // Module routes
// router.get('/:courseId/modules', validateMongoId, getCourseModules)

// // Forward module routes to module router
// router.use('/:courseId/modules', moduleRouter)

// // Forward lesson routes from course level
// router.use('/:courseId/modules/:moduleId/lessons', lessonRouter)

// module.exports = router
