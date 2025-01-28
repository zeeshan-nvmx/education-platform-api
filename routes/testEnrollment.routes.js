const express = require('express')
const { protect } = require('../middleware/auth')
const { enrollInCourse, enrollInModule } = require('../controllers/testEnrollment.controller')

const router = express.Router()

// Course enrollment
router.post('/courses/:courseId/enroll', protect, enrollInCourse)

// Module enrollment
router.post('/courses/:courseId/modules/:moduleId/enroll', protect, enrollInModule)

module.exports = router

// // testEnrollment.routes.js
// const express = require('express')
// const { protect } = require('../middleware/auth')
// const { enrollInCourse, enrollInModule } = require('../controllers/testEnrollment.controller')

// const router = express.Router()

// router.use(protect)

// router.post('/courses/:courseId/enroll', enrollInCourse)
// router.post('/courses/:courseId/modules/:moduleId/enroll', enrollInModule)

// module.exports = router
