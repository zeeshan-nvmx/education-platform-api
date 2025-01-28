const express = require('express')
const { protect, isEmailVerified } = require('../middleware/auth')
const { getProfile, updateProfile, getEnrolledCourses, getCourseProgress } = require('../controllers/user.controller')

const router = express.Router()

// Profile management routes
router.get('/profile', protect, /*isEmailVerified,*/ getProfile)
router.put('/profile', protect, /*isEmailVerified,*/ updateProfile)

// Enrollment and progress tracking routes
router.get('/enrolled-courses', protect, /*isEmailVerified,*/ getEnrolledCourses)
router.get('/course-progress/:courseId', protect, /*isEmailVerified,*/ getCourseProgress)

module.exports = router

// const express = require('express')
// const { protect, isEmailVerified } = require('../middleware/auth')
// const { getProfile, updateProfile, getEnrolledCourses, getCourseProgress } = require('../controllers/user.controller')

// const router = express.Router()

// // Protect all routes after this middleware
// router.use(protect)
// router.use(isEmailVerified)

// router.get('/profile', getProfile)
// router.put('/profile', updateProfile)
// router.get('/enrolled-courses', getEnrolledCourses)
// router.get('/course-progress/:courseId', getCourseProgress)

// module.exports = router
