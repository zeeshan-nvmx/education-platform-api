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
// router.get('/:moduleId/lessons', protect, validateMongoId, getModuleLessons)
router.get('/:moduleId/enrollment-status', protect, validateMongoId, getModuleEnrollmentStatus)

// Routes requiring admin rights
router.post('/', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ createModule)

router.put('/:moduleId', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, updateModule)

router.delete('/:moduleId', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, deleteModule)

// Module order and prerequisites management
router.put('/reorder', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ reorderModules)

router.put('/:moduleId/prerequisites', protect, restrictTo('admin', 'subAdmin'), /* checkCourseOwnership, */ validateMongoId, updateModulePrerequisites)

// // Forward lesson routes
// router.use('/:moduleId/lessons', lessonRouter)

module.exports = router