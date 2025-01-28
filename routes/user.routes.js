const express = require('express')
const { protect, isEmailVerified } = require('../middleware/auth')
const { getProfile, updateProfile, getEnrolledCourses, getCourseProgress } = require('../controllers/user.controller')

const router = express.Router()

// Protect all routes after this middleware
router.use(protect)
router.use(isEmailVerified)

router.get('/profile', getProfile)
router.put('/profile', updateProfile)
router.get('/enrolled-courses', getEnrolledCourses)
router.get('/course-progress/:courseId', getCourseProgress)

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
