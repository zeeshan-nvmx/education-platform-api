const express = require('express')
const { protect, restrictTo } = require('../middleware/auth')
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

const router = express.Router({ mergeParams: true })

// Routes for enrolled students - require authentication only
router.get('/', protect, validateMongoId, getModules)

router.get('/:moduleId', protect, validateMongoId, getModule)

router.get('/:moduleId/lessons', protect, validateMongoId, getModuleLessons)

router.get('/:moduleId/enrollment-status', protect, validateMongoId, getModuleEnrollmentStatus)

// Routes requiring course ownership or admin rights
router.post('/', protect, checkCourseOwnership, createModule)

router.put('/:moduleId', protect, checkCourseOwnership, validateMongoId, updateModule)

router.delete('/:moduleId', protect, checkCourseOwnership, validateMongoId, deleteModule)

// Module order and prerequisites management
router.put('/reorder', protect, checkCourseOwnership, reorderModules)

router.put('/:moduleId/prerequisites', protect, checkCourseOwnership, validateMongoId, updateModulePrerequisites)

// Forward lesson routes
router.use('/:moduleId/lessons', lessonRouter)

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

// // Protect all module routes
// router.use(protect)

// // Public module routes (for enrolled students)
// router.get('/', validateMongoId, getModules)
// router.get('/:moduleId', validateMongoId, getModule)
// router.get('/:moduleId/lessons', validateMongoId, getModuleLessons)
// router.get('/:moduleId/enrollment-status', validateMongoId, getModuleEnrollmentStatus)

// // Routes requiring course ownership or admin rights
// router.use(checkCourseOwnership)

// // Module management routes
// router.post('/', createModule)
// router.put('/:moduleId', validateMongoId, updateModule)
// router.delete('/:moduleId', validateMongoId, deleteModule)

// // Module order and prerequisites management
// router.put('/reorder', reorderModules)
// router.put('/:moduleId/prerequisites', validateMongoId, updateModulePrerequisites)

// // Forward lesson routes from module level
// router.use('/:moduleId/lessons', lessonRouter)

// module.exports = router
