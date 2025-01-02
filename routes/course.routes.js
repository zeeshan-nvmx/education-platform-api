const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')

const { createCourse, getAllCourses, getCourse, updateCourse, deleteCourse, getFeaturedCourses, getCoursesByCategory } = require('../controllers/course.controller')

const router = express.Router()

// Public routes
router.get('/featured', getFeaturedCourses)
router.get('/category/:category', getCoursesByCategory)

// Protected routes
router.use(protect)

// Routes for admin and subAdmin
router.route('/').post(restrictTo('admin', 'subAdmin'), createCourse).get(getAllCourses)

// Routes requiring course ownership or admin rights
router
  .route('/:courseId')
  .get(getCourse)
  .put(checkCourseOwnership, updateCourse)
  .delete(checkCourseOwnership, deleteCourse)

module.exports = router

// const express = require('express')
// const { protect, restrictTo } = require('../middleware/auth')
// const { checkCourseOwnership } = require('../middleware/checkOwnership')
// const { createCourse, getAllCourses, getCourse, updateCourse, deleteCourse, getFeaturedCourses, getCoursesByCategory } = require('../controllers/course.controller')

// const router = express.Router()

// // Public routes
// router.get('/featured', getFeaturedCourses)
// router.get('/category/:category', getCoursesByCategory)
// router.get('/', getAllCourses)

// // Protected routes
// router.use(protect)

// // Create course - only admin and subAdmin can create courses
// router.post('/', restrictTo('admin', 'subAdmin'), createCourse)

// // Get, update, and delete specific course
// router.get('/:courseId', getCourse)
// router.put('/:courseId', checkCourseOwnership, updateCourse)
// router.delete('/:courseId', checkCourseOwnership, deleteCourse)

// module.exports = router
