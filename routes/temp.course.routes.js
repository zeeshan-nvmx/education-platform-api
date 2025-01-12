const express = require('express')
const multer = require('multer')
const { protect, restrictTo } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')

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
  { name: 'instructorImages', maxCount: 10 }, // Allow up to 10 instructor images
])

const { createCourse, getAllCourses, getCourse, updateCourse, deleteCourse, getFeaturedCourses, getCoursesByCategory } = require('../controllers/course.controller')

const router = express.Router()

// Public routes
router.get('/featured', getFeaturedCourses)
router.get('/category/:category', getCoursesByCategory)
router.get('/', getAllCourses)
router.get('/:courseId', getCourse)

// Protected routes with admin/subAdmin access
router.post('/', protect, restrictTo('admin', 'subAdmin'), uploadFields, createCourse)

// Protected routes requiring course ownership
router.put('/:courseId', protect, checkCourseOwnership, uploadFields, updateCourse)
router.delete('/:courseId', protect, checkCourseOwnership, deleteCourse)

module.exports = router

// const express = require('express')
// const { protect, restrictTo } = require('../middleware/auth')
// const { checkCourseOwnership } = require('../middleware/checkOwnership')

// const { createCourse, getAllCourses, getCourse, updateCourse, deleteCourse, getFeaturedCourses, getCoursesByCategory } = require('../controllers/course.controller')

// const router = express.Router()

// // Public routes
// router.get('/featured', getFeaturedCourses)
// router.get('/category/:category', getCoursesByCategory)

// // Protected routes
// router.use(protect)

// // Routes for admin and subAdmin
// router.route('/').post(restrictTo('admin', 'subAdmin'), createCourse).get(getAllCourses)

// // Routes requiring course ownership or admin rights
// router
//   .route('/:courseId')
//   .get(getCourse)
//   .put(checkCourseOwnership, updateCourse)
//   .delete(checkCourseOwnership, deleteCourse)

// module.exports = router
