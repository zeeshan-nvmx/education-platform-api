const express = require('express')
const { protect, isEmailVerified } = require('../middleware/auth')
const multer = require('multer')
const { getProfile, updateProfile, getEnrolledCourses, getCourseProgress, uploadProfileImage } = require('../controllers/user.controller')

const router = express.Router()


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


// Profile management routes
router.get('/profile', protect, /*isEmailVerified,*/ getProfile)
router.put('/profile', protect, /*isEmailVerified,*/ updateProfile)

// Profile image upload route
router.post('/profile/image', protect, /*isEmailVerified,*/ upload.single('image'), uploadProfileImage)

// Enrollment and progress tracking routes
router.get('/enrolled-courses', protect, /*isEmailVerified,*/ getEnrolledCourses)
router.get('/course-progress/:courseId', protect, /*isEmailVerified,*/ getCourseProgress)

module.exports = router
