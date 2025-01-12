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

// Protect all module routes
router.use(protect)

// Public module routes (for enrolled students)
router.get('/', validateMongoId, getModules)
router.get('/:moduleId', validateMongoId, getModule)
router.get('/:moduleId/lessons', validateMongoId, getModuleLessons)
router.get('/:moduleId/enrollment-status', validateMongoId, getModuleEnrollmentStatus)

// Routes requiring course ownership or admin rights
router.use(checkCourseOwnership)

// Module management routes
router.post('/', createModule)
router.put('/:moduleId', validateMongoId, updateModule)
router.delete('/:moduleId', validateMongoId, deleteModule)

// Module order and prerequisites management
router.put('/reorder', reorderModules)
router.put('/:moduleId/prerequisites', validateMongoId, updateModulePrerequisites)

// Forward lesson routes from module level
router.use('/:moduleId/lessons', lessonRouter)

module.exports = router

// const express = require('express')
// const { protect, restrictTo } = require('../middleware/auth')
// const { checkCourseOwnership } = require('../middleware/checkOwnership')
// const validateMongoId = require('../middleware/validateMongoId')
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

// module.exports = router
