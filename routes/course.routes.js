const express = require('express')
const multer = require('multer')
const { protect, restrictTo } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')
const validateMongoId = require('../middleware/validateMongoId')

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
} = require('../controllers/course.controller')

const router = express.Router()

// Public routes
router.get('/featured', getFeaturedCourses)
router.get('/category/:category', getCoursesByCategory)
router.get('/', getAllCourses)
router.get('/:courseId', validateMongoId, getCourse)

// Protected routes
router.use(protect)

// Course progress routes
router.get('/:courseId/progress', validateMongoId, getCourseProgress)
router.get('/:courseId/modules/:moduleId/progress', validateMongoId, getModuleProgress)
router.get('/:courseId/modules/:moduleId/access', validateMongoId, checkModuleAccess)

// Course management routes (admin/subAdmin only)
router.use(restrictTo('admin', 'subAdmin'))
router.route('/').post(uploadFields, createCourse)

// Routes requiring course ownership
router.use('/:courseId', validateMongoId, checkCourseOwnership)
router.route('/:courseId').put(uploadFields, updateCourse).delete(deleteCourse)

// Module routes
router.get('/:courseId/modules', validateMongoId, getCourseModules)

module.exports = router
