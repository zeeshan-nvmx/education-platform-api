const express = require('express')
const { protect, restrictTo, optionalAuth } = require('../middleware/auth')
const { checkCourseOwnership } = require('../middleware/checkOwnership')
const validateMongoId = require('../middleware/validateMongoId')

// Import lesson router
const lessonRouter = require('./lesson.routes')

const {
  createModule,
  getModules,
  getModule,
  updateModule,
  deleteModule,
  getModuleLessons,
  reorderModules,
  updateModulePrerequisites,
  getModuleEnrollmentStatus,
} = require('../controllers/module.controller')

// Import module review controller
const { createModuleReview, getModuleReview, deleteModuleReview, getAllModuleReviews, getPublicModuleReviews,deleteReviewAdmin } = require('../controllers/moduleReview.controller')

const router = express.Router({ mergeParams: true })

// Routes for enrolled students - require authentication only
router.get('/', protect, validateMongoId, getModules)
router.get('/:moduleId', protect, validateMongoId, getModule)
router.get('/:moduleId/enrollment-status', protect, validateMongoId, getModuleEnrollmentStatus)

// Routes requiring admin rights
router.post('/', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ createModule)
router.put('/:moduleId', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, updateModule)
router.delete('/:moduleId', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, deleteModule)

// Module order and prerequisites management
router.put('/reorder', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ reorderModules)
router.put('/:moduleId/prerequisites', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, updateModulePrerequisites)

// Public review routes with optional authentication
router.get('/:moduleId/reviews', optionalAuth, validateMongoId, getPublicModuleReviews)

// Protected review routes - require authentication
router.post('/:moduleId/reviews', protect, validateMongoId, createModuleReview)
router.get('/:moduleId/reviews/my', protect, validateMongoId, getModuleReview)
router.delete('/:moduleId/reviews/my', protect, validateMongoId, deleteModuleReview)

// Admin review routes
router.get('/:moduleId/reviews/admin', protect, restrictTo('admin', 'subAdmin', 'moderator'), validateMongoId, getAllModuleReviews)
router.delete('/:moduleId/reviews/:reviewId', protect, restrictTo('admin', 'subAdmin', 'moderator'), validateMongoId, deleteReviewAdmin)

module.exports = router

// const express = require('express')
// const { protect, restrictTo } = require('../middleware/auth')
// const { checkCourseOwnership } = require('../middleware/checkOwnership')
// const validateMongoId = require('../middleware/validateMongoId')

// // Import lesson router
// const lessonRouter = require('./lesson.routes')

// const {
//   createModule,
//   getModules,
//   getModule,
//   updateModule,
//   deleteModule,
//   getModuleLessons,
//   reorderModules,
//   updateModulePrerequisites,
//   getModuleEnrollmentStatus,
// } = require('../controllers/module.controller')

// const router = express.Router({ mergeParams: true })

// // Routes for enrolled students - require authentication only
// router.get('/', protect, validateMongoId, getModules)
// router.get('/:moduleId', protect, validateMongoId, getModule)
// // router.get('/:moduleId/lessons', protect, validateMongoId, getModuleLessons)
// router.get('/:moduleId/enrollment-status', protect, validateMongoId, getModuleEnrollmentStatus)

// // Routes requiring admin rights
// router.post('/', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ createModule)

// router.put('/:moduleId', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, updateModule)

// router.delete('/:moduleId', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, deleteModule)

// // Module order and prerequisites management
// router.put('/reorder', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ reorderModules)

// router.put('/:moduleId/prerequisites', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, updateModulePrerequisites)

// // // Forward lesson routes
// // router.use('/:moduleId/lessons', lessonRouter)

// module.exports = router
